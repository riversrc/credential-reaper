// The Netrunner agent's controlled tool surface. The model can only *request*
// tools by name; every request is parsed, validated, scoped to the identity
// under investigation, and executed here against SpacetimeDB. There is
// deliberately no tool that touches a real credential or secrets manager:
// the strongest write available is proposing a remediation plan, which stays
// in "proposed" status until a human acts on it.
import type {
  FindingBasis,
  FindingSeverity,
  InvestigationFinding,
  RemediationAction,
  RemediationStep,
  ToolTraceEntry,
} from '@credential-reaper/shared';
import type { SpacetimeEnv } from '../spacetime/client.js';
import {
  fetchCredentials,
  fetchDependencies,
  fetchIdentity,
  fetchIdentityDetail,
  fetchPermissions,
  fetchUsageEvents,
  proposeRemediationRow,
  recordFindingRow,
} from '../spacetime/repository.js';
import { computeRisk, daysSince, isExternalOwner, isUnowned, lastActivityAt, type RiskResult } from './risk.js';

export const MAX_FINDINGS = 12;
const MAX_USAGE_EVENTS = 100;
const MAX_RESULT_CHARS = 8000;

export const RETRIEVAL_TOOLS = [
  'get_identity_details',
  'get_ownership',
  'get_permissions',
  'get_dependencies',
  'get_usage_history',
  'get_risk_assessment',
] as const;
type RetrievalTool = (typeof RETRIEVAL_TOOLS)[number];

const CATEGORIES = ['ownership', 'dormancy', 'over-permissioning', 'credential-hygiene', 'dependencies', 'usage-anomaly', 'risk-posture'];
const SEVERITIES: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
const BASES: FindingBasis[] = ['confirmed', 'inferred', 'unknown'];
const ACTIONS: (RemediationAction | 'no-action')[] = ['retire', 'rotate', 'migrate', 'monitor', 'no-action'];

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export interface Recommendation {
  action: RemediationAction | 'no-action';
  justification: string;
  planId: string | null;
}

export interface ToolboxState {
  findings: InvestigationFinding[];
  recommendation: Recommendation | null;
  trace: ToolTraceEntry[];
}

export interface Toolbox {
  readonly definitions: ToolDefinition[];
  readonly state: ToolboxState;
  /** Executes one model-requested tool call. Never throws; failures come back as `{ok:false}` for the model to react to. */
  execute(name: string, rawArguments: string): Promise<string>;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Fresh deterministic risk computation straight from SpacetimeDB (not from anything the model said). */
  computeRisk(): Promise<RiskResult>;
}

/** Static, user-facing descriptions. Activity events never carry tool arguments or results, only these strings. */
const TOOL_ACTIVITY: Record<string, string> = {
  get_identity_details: 'Reading identity record and credential metadata',
  get_ownership: 'Checking ownership',
  get_permissions: 'Reading permission grants',
  get_dependencies: 'Listing recorded dependencies',
  get_usage_history: 'Reviewing usage history',
  get_risk_assessment: 'Computing the deterministic risk assessment',
  record_finding: 'Recording a finding',
  recommend_remediation: 'Proposing a remediation plan for human review',
};
const UNRECOGNIZED_TOOL_ACTIVITY = 'Received an unrecognized tool request';

/** Safe-by-construction progress notifications: `tool` is a known tool name or null, never raw model text. */
export type ToolboxEvent =
  | { type: 'tool-started'; seq: number; tool: string | null; message: string; analysis: boolean }
  | { type: 'tool-finished'; seq: number; tool: string | null; message: string; status: ToolTraceEntry['status']; durationMs: number; detail: string }
  | { type: 'finding-recorded'; number: number; category: string; severity: string; basis: string };

export interface ToolboxOptions {
  /** Awaited in order; failures are caught and logged here and never affect the tool call. */
  onEvent?: (event: ToolboxEvent) => Promise<void>;
}

export interface ToolboxContext {
  investigationId: string;
  identityId: string;
  identityName: string;
}

const identityIdParam = {
  identity_id: { type: 'string', description: 'The id of the identity under investigation. Any other id is rejected.' },
};

function retrievalTool(name: RetrievalTool, description: string, extra: Record<string, unknown> = {}): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties: { ...identityIdParam, ...extra }, required: ['identity_id'], additionalProperties: false },
    },
  };
}

const DEFINITIONS: ToolDefinition[] = [
  retrievalTool(
    'get_identity_details',
    'Retrieve the identity record (name, type, owner, team, environment, status, tags, description, timestamps) and credential METADATA (masked previews, storage location, rotation and expiry dates). Secret values are never available.'
  ),
  retrievalTool(
    'get_ownership',
    'Identify ownership: the recorded owner and team, whether the owner field is unassigned or external, who granted the permissions, and what ownership facts this system cannot verify.'
  ),
  retrievalTool('get_permissions', 'List every permission grant held by the identity (resource, scope, when granted, by whom).'),
  retrievalTool(
    'get_dependencies',
    'List the services, pipelines, applications and data stores recorded as depending on or provided by the identity. An empty list is NOT proof that nothing depends on it.'
  ),
  retrievalTool(
    'get_usage_history',
    'Retrieve recorded usage events (newest first) plus a summary: last event time, days idle, result counts, distinct sources.',
    { limit: { type: 'integer', minimum: 1, maximum: MAX_USAGE_EVENTS, description: `Max events to return (default 50, max ${MAX_USAGE_EVENTS}).` } }
  ),
  retrievalTool(
    'get_risk_assessment',
    'Get the backend-computed risk score, level, contributing factors and the deterministic suggested action. You cannot change or override the score.'
  ),
  {
    type: 'function',
    function: {
      name: 'record_finding',
      description:
        'Record one finding to the investigation. Findings must be backed by tool results you already retrieved. basis=confirmed: directly stated by retrieved data. basis=inferred: a risk you reasoned from retrieved data. basis=unknown: something the data cannot answer. For confirmed/inferred, `evidence` must quote exact values (names, dates, scopes) from the cited tools.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: CATEGORIES },
          severity: { type: 'string', enum: SEVERITIES },
          basis: { type: 'string', enum: BASES },
          description: { type: 'string', description: 'One sentence stating the finding (10-400 chars).' },
          evidence: { type: 'string', description: 'Exact values from tool results that support the finding (5-600 chars).' },
          sources: {
            type: 'array',
            items: { type: 'string', enum: [...RETRIEVAL_TOOLS] },
            description: 'Retrieval tools whose results support this finding. Required for confirmed and inferred.',
          },
        },
        required: ['category', 'severity', 'basis', 'description', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recommend_remediation',
      description:
        'Propose exactly one remediation for this identity after recording findings and checking get_risk_assessment. This only creates a PROPOSED plan for human review; it cannot revoke, delete, rotate or change anything.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ACTIONS },
          justification: { type: 'string', description: 'Why, citing recorded findings (20-600 chars).' },
        },
        required: ['action', 'justification'],
        additionalProperties: false,
      },
    },
  },
];

const PLAN_STEPS: Record<RemediationAction, string[]> = {
  retire: [
    'Confirm with the owning team (or the last known owner) that the identity is no longer needed.',
    'Check logs and dependency records for any remaining callers before changing anything.',
    'Run a dry-run simulation of the retirement and review the result.',
    'After human approval, a credentials administrator disables and then revokes the credential in the system of record.',
  ],
  rotate: [
    'Confirm the current owner and the systems that use this credential.',
    'Issue a replacement credential in the system of record and update dependents.',
    'After human approval, a credentials administrator revokes the old credential.',
  ],
  migrate: [
    'Assign an accountable owner and record them against the identity.',
    'Identify consumers and plan a move to a managed, owned replacement identity.',
    'After human approval, cut consumers over and retire the old identity.',
  ],
  monitor: [
    'Enable alerting on usage of this identity and on changes to its permissions.',
    'Re-run an investigation after the next review period.',
  ],
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Flattens a tool result into its string/number leaf values, used to check that finding evidence quotes real data. */
function collectLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string' || typeof value === 'number') out.push(String(value).toLowerCase());
  else if (Array.isArray(value)) value.forEach((v) => collectLeaves(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectLeaves(v, out));
  return out;
}

function str(args: Record<string, unknown>, key: string, min: number, max: number): string {
  const value = args[key];
  if (typeof value !== 'string') throw new ToolInputError(`"${key}" must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new ToolInputError(`"${key}" must be ${min}-${max} characters`);
  return trimmed;
}

function oneOf<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = args[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ToolInputError(`"${key}" must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

class ToolInputError extends Error {}

export function createToolbox(env: SpacetimeEnv, ctx: ToolboxContext, options: ToolboxOptions = {}): Toolbox {
  const state: ToolboxState = { findings: [], recommendation: null, trace: [] };
  const retrieved = new Map<RetrievalTool, string[]>();
  let riskChecked = false;

  async function loadDetail() {
    const detail = await fetchIdentityDetail(env, ctx.identityId);
    if (!detail) throw new ToolInputError(`Identity ${ctx.identityId} no longer exists`);
    return detail;
  }

  async function run(name: string, args: Record<string, unknown>): Promise<{ data: unknown; summary: string }> {
    const now = new Date();

    if ((RETRIEVAL_TOOLS as readonly string[]).includes(name)) {
      if (args.identity_id !== ctx.identityId) {
        throw new ToolInputError(`Rejected: this investigation is scoped to identity_id "${ctx.identityId}"`);
      }
    }

    switch (name) {
      case 'get_identity_details': {
        const [identity, credentials] = await Promise.all([fetchIdentity(env, ctx.identityId), fetchCredentials(env, ctx.identityId)]);
        if (!identity) throw new ToolInputError(`Identity ${ctx.identityId} no longer exists`);
        return { data: { identity, credentials }, summary: `identity record and ${credentials.length} credential metadata record(s)` };
      }

      case 'get_ownership': {
        const [identity, permissions] = await Promise.all([fetchIdentity(env, ctx.identityId), fetchPermissions(env, ctx.identityId)]);
        if (!identity) throw new ToolInputError(`Identity ${ctx.identityId} no longer exists`);
        const grantors: Record<string, number> = {};
        for (const p of permissions) grantors[p.grantedBy] = (grantors[p.grantedBy] ?? 0) + 1;
        const ownerStatus = isUnowned(identity.owner) ? 'unassigned' : isExternalOwner(identity) ? 'external' : 'named';
        return {
          data: {
            owner: identity.owner,
            team: identity.team,
            ownerStatus,
            ownershipTags: identity.tags.filter((t) => /owner|contractor|offboard/i.test(t)),
            permissionGrantors: grantors,
            cannotVerify: [
              'Whether the named owner is still employed or active (no directory/HR integration).',
              'Whether the owning team still exists.',
            ],
          },
          summary: `owner "${identity.owner}" (${ownerStatus})`,
        };
      }

      case 'get_permissions': {
        const permissions = await fetchPermissions(env, ctx.identityId);
        return { data: { permissions }, summary: `${permissions.length} permission grant(s)` };
      }

      case 'get_dependencies': {
        const dependencies = await fetchDependencies(env, ctx.identityId);
        return {
          data: {
            dependencies,
            note: 'Only recorded dependencies are listed. No records does not prove nothing depends on this identity.',
          },
          summary: `${dependencies.length} dependency record(s)`,
        };
      }

      case 'get_usage_history': {
        let limit = 50;
        if (args.limit !== undefined) {
          if (!Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > MAX_USAGE_EVENTS) {
            throw new ToolInputError(`"limit" must be an integer between 1 and ${MAX_USAGE_EVENTS}`);
          }
          limit = args.limit as number;
        }
        const [identity, events] = await Promise.all([fetchIdentity(env, ctx.identityId), fetchUsageEvents(env, ctx.identityId)]);
        if (!identity) throw new ToolInputError(`Identity ${ctx.identityId} no longer exists`);
        const sorted = [...events].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        const resultCounts: Record<string, number> = {};
        for (const e of sorted) resultCounts[e.result] = (resultCounts[e.result] ?? 0) + 1;
        const lastActivity = lastActivityAt(identity, events);
        return {
          data: {
            asOf: now.toISOString(),
            totalEventsRecorded: sorted.length,
            returned: Math.min(limit, sorted.length),
            lastUsedAtOnIdentity: identity.lastUsedAt,
            lastActivityAt: lastActivity,
            daysIdle: daysSince(lastActivity, now),
            resultCounts,
            distinctSources: [...new Set(sorted.map((e) => e.source))],
            events: sorted.slice(0, limit),
            runtimeEvidenceAvailable: identity.dataSource !== 'repository',
            note:
              identity.dataSource === 'repository'
                ? 'This identity comes from repository declarations. No runtime usage data has ever been collected for it, so its usage is UNKNOWN, not zero.'
                : 'The retention window of the usage log is unknown; an empty log is not proof of no use.',
          },
          summary: `${sorted.length} event(s), idle ${daysSince(lastActivity, now) ?? 'unknown'} day(s)`,
        };
      }

      case 'get_risk_assessment': {
        const risk = computeRisk(await loadDetail(), now);
        riskChecked = true;
        return {
          data: { ...risk, computedBy: 'backend deterministic rules; not adjustable by the agent' },
          summary: `score ${risk.score} (${risk.level}), suggests ${risk.suggestedAction}`,
        };
      }

      case 'record_finding': {
        if (state.findings.length >= MAX_FINDINGS) throw new ToolInputError(`Finding limit (${MAX_FINDINGS}) reached; stop recording and finish.`);
        const category = oneOf(args, 'category', CATEGORIES);
        const severity = oneOf(args, 'severity', SEVERITIES);
        const basis = oneOf(args, 'basis', BASES);
        const description = str(args, 'description', 10, 400);
        const evidence = str(args, 'evidence', 5, 600);

        const rawSources = args.sources ?? [];
        if (!Array.isArray(rawSources) || rawSources.length > RETRIEVAL_TOOLS.length || rawSources.some((s) => !(RETRIEVAL_TOOLS as readonly unknown[]).includes(s))) {
          throw new ToolInputError(`"sources" must be an array of: ${RETRIEVAL_TOOLS.join(', ')}`);
        }
        const sources = [...new Set(rawSources as RetrievalTool[])];

        if (basis !== 'unknown') {
          if (sources.length === 0) throw new ToolInputError(`basis "${basis}" requires "sources" naming the tools whose results support it`);
          const missing = sources.filter((s) => !retrieved.has(s));
          if (missing.length > 0) throw new ToolInputError(`You have not successfully called: ${missing.join(', ')}. Retrieve the evidence first.`);
          const haystack = evidence.toLowerCase();
          const quotesData = sources.some((s) => retrieved.get(s)!.some((leaf) => leaf.length >= 3 && haystack.includes(leaf)));
          if (!quotesData) {
            throw new ToolInputError(
              `"evidence" does not quote any value returned by ${sources.join(', ')}. Quote exact values (names, dates, scopes) from the tool result, or record this as basis "unknown".`
            );
          }
        }

        const key = `${category}|${basis}|${description.toLowerCase()}`;
        if (state.findings.some((f) => `${f.category}|${f.basis}|${f.description.toLowerCase()}` === key)) {
          throw new ToolInputError('Duplicate finding; it is already recorded.');
        }

        const finding: InvestigationFinding = {
          id: crypto.randomUUID(),
          category,
          severity,
          basis,
          description,
          evidence: sources.length > 0 ? `${evidence} [sources: ${sources.join(', ')}]` : evidence,
        };
        await recordFindingRow(env, ctx.investigationId, finding);
        state.findings.push(finding);
        return { data: { recorded: true, findingId: finding.id, totalFindings: state.findings.length }, summary: `${basis} ${severity} ${category} finding` };
      }

      case 'recommend_remediation': {
        if (state.recommendation) throw new ToolInputError('A recommendation was already recorded for this investigation.');
        if (state.findings.length === 0) throw new ToolInputError('Record at least one finding before recommending remediation.');
        if (!riskChecked) throw new ToolInputError('Call get_risk_assessment before recommending remediation.');
        const action = oneOf(args, 'action', ACTIONS);
        const justification = str(args, 'justification', 20, 600);

        let planId: string | null = null;
        if (action !== 'no-action') {
          planId = crypto.randomUUID();
          const steps: RemediationStep[] = PLAN_STEPS[action].map((description, i) => ({
            id: `${planId}-step-${i + 1}`,
            order: i + 1,
            description,
            automatable: false,
          }));
          await proposeRemediationRow(env, {
            id: planId,
            identityId: ctx.identityId,
            identityName: ctx.identityName,
            investigationId: ctx.investigationId,
            action,
            justification,
            steps,
            createdAt: now.toISOString(),
            actor: 'nemotron-ai',
          });
        }
        state.recommendation = { action, justification, planId };
        return {
          data: {
            recorded: true,
            action,
            planId,
            status: planId ? 'proposed' : 'none',
            note: 'Proposed only. A human must review and approve it; no credential has been or will be changed by this tool.',
          },
          summary: planId ? `proposed "${action}" plan (awaiting human approval)` : 'no action recommended',
        };
      }

      default:
        throw new ToolInputError(`Unknown tool "${name}". Available: ${DEFINITIONS.map((d) => d.function.name).join(', ')}`);
    }
  }

  async function emit(event: ToolboxEvent): Promise<void> {
    if (!options.onEvent) return;
    try {
      await options.onEvent(event);
    } catch {
      console.log(JSON.stringify({ event: 'activity_event_failed', investigationId: ctx.investigationId, type: event.type }));
    }
  }

  /** Emits the started / finished pair for a trace entry; `known` is false for tool names we do not offer. */
  function activity(name: string) {
    const known = Object.hasOwn(TOOL_ACTIVITY, name);
    return {
      tool: known ? name : null,
      message: known ? TOOL_ACTIVITY[name]! : UNRECOGNIZED_TOOL_ACTIVITY,
      analysis: name === 'record_finding' || name === 'recommend_remediation',
    };
  }

  async function emitFinished(name: string, entry: ToolTraceEntry): Promise<void> {
    const a = activity(name);
    const outcome = entry.status === 'ok' ? 'done' : entry.status === 'rejected' ? 'rejected' : 'failed';
    // Internal error text and unrecognized tool names stay out of events; they remain only in the stored trace.
    const detail = entry.status === 'error' ? 'internal error' : a.tool === null ? 'tool is not available' : entry.summary;
    await emit({ type: 'tool-finished', seq: entry.seq, tool: a.tool, message: `${a.message} (${outcome})`, status: entry.status, durationMs: entry.durationMs, detail });
  }

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const started = Date.now();
    const seq = state.trace.length + 1;
    const a = activity(name);
    await emit({ type: 'tool-started', seq, tool: a.tool, message: a.message, analysis: a.analysis });
    let result: ToolResult;
    let status: ToolTraceEntry['status'];
    let summary: string;

    try {
      const { data, summary: s } = await run(name, args);
      if ((RETRIEVAL_TOOLS as readonly string[]).includes(name)) retrieved.set(name as RetrievalTool, collectLeaves(data));
      result = { ok: true, data };
      status = 'ok';
      summary = s;
    } catch (e) {
      const rejected = e instanceof ToolInputError;
      status = rejected ? 'rejected' : 'error';
      summary = truncate((e as Error).message, 200);
      result = { ok: false, error: rejected ? (e as Error).message : 'Internal error while running this tool; try a different approach or finish.' };
    }

    const durationMs = Date.now() - started;
    const entry: ToolTraceEntry = { seq, tool: truncate(name, 60), status, summary, durationMs };
    state.trace.push(entry);
    console.log(JSON.stringify({ event: 'tool_call', investigationId: ctx.investigationId, seq, tool: name, status, durationMs }));
    await emitFinished(name, entry);
    if (name === 'record_finding' && status === 'ok') {
      const f = state.findings[state.findings.length - 1]!;
      await emit({ type: 'finding-recorded', number: state.findings.length, category: f.category, severity: f.severity, basis: f.basis });
    }
    return result;
  }

  return {
    definitions: DEFINITIONS,
    state,
    call,
    async execute(name, rawArguments) {
      let parsed: unknown;
      try {
        parsed = rawArguments.trim() === '' ? {} : JSON.parse(rawArguments);
      } catch {
        parsed = null;
      }
      let result: ToolResult;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const a = activity(name);
        const seq = state.trace.length + 1;
        await emit({ type: 'tool-started', seq, tool: a.tool, message: a.message, analysis: a.analysis });
        const entry: ToolTraceEntry = { seq, tool: truncate(name, 60), status: 'rejected', summary: 'arguments were not a valid JSON object', durationMs: 0 };
        state.trace.push(entry);
        await emitFinished(name, entry);
        console.log(JSON.stringify({ event: 'tool_call', investigationId: ctx.investigationId, tool: name, status: 'rejected', reason: 'invalid_json_arguments' }));
        result = { ok: false, error: 'Tool arguments must be a valid JSON object.' };
      } else {
        result = await call(name, parsed as Record<string, unknown>);
      }
      return truncate(JSON.stringify(result), MAX_RESULT_CHARS);
    },
    async computeRisk() {
      return computeRisk(await loadDetail());
    },
  };
}
