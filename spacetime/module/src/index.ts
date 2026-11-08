// SpacetimeDB 2.x server module (TypeScript) for Credential Reaper.
//
// Persistent tables and reducers behind the machine identity inventory,
// investigations, remediation plans, and audit trail.
//
// Access model: every table is private. Only identities registered in the
// `authorized_caller` table (the Cloudflare Worker's service identity) may call
// a reducer or read data, and reads go through the gated `v_*` views at the end
// of this file. `authorized_caller` has no reducer: the database owner edits it
// with owner-only SQL (see spacetime/scripts/provision-worker-identity.sh).
//
// Timestamps are stored as ISO 8601 strings (not SpacetimeDB's native
// `Timestamp` type) so row shapes match packages/shared exactly and can be
// passed straight through the Worker API without conversion.
//
// Run with the SpacetimeDB CLI (not included in this repo):
//   spacetime dev --project-path spacetime/module
import { schema, SenderError, table, t } from 'spacetimedb/server';

const finding = t.object('Finding', {
  id: t.string(),
  category: t.string(),
  severity: t.string(),
  description: t.string(),
  evidence: t.string(),
});

const toolTraceEntry = t.object('ToolTraceEntry', {
  seq: t.u32(),
  tool: t.string(),
  status: t.string(),
  summary: t.string(),
  durationMs: t.u32(),
});

const remediationStep = t.object('RemediationStep', {
  id: t.string(),
  order: t.u32(),
  description: t.string(),
  automatable: t.bool(),
});

const machineIdentity = table(
  { name: 'machine_identity' },
  {
    id: t.string().primaryKey(),
    name: t.string(),
    type: t.string(),
    owner: t.string(),
    team: t.string(),
    environment: t.string(),
    status: t.string(),
    riskLevel: t.string(),
    riskScore: t.u32(),
    createdAt: t.string(),
    lastUsedAt: t.option(t.string()),
    tags: t.array(t.string()),
    description: t.string(),
  }
);

const permissionGrant = table(
  { name: 'permission_grant', indexes: [{ accessor: 'byIdentity', algorithm: 'btree', columns: ['identityId'] }] },
  {
    id: t.string().primaryKey(),
    identityId: t.string(),
    resource: t.string(),
    scope: t.string(),
    grantedAt: t.string(),
    grantedBy: t.string(),
  }
);

const identityDependency = table(
  { name: 'identity_dependency', indexes: [{ accessor: 'byIdentity', algorithm: 'btree', columns: ['identityId'] }] },
  {
    id: t.string().primaryKey(),
    identityId: t.string(),
    name: t.string(),
    kind: t.string(),
    relationship: t.string(),
  }
);

const credentialMetadata = table(
  { name: 'credential_metadata', indexes: [{ accessor: 'byIdentity', algorithm: 'btree', columns: ['identityId'] }] },
  {
    id: t.string().primaryKey(),
    identityId: t.string(),
    kind: t.string(),
    storageLocation: t.string(),
    maskedPreview: t.string(),
    createdAt: t.string(),
    lastRotatedAt: t.option(t.string()),
    expiresAt: t.option(t.string()),
  }
);

const usageEvent = table(
  { name: 'usage_event', indexes: [{ accessor: 'byIdentity', algorithm: 'btree', columns: ['identityId'] }] },
  {
    id: t.string().primaryKey(),
    identityId: t.string(),
    timestamp: t.string(),
    action: t.string(),
    source: t.string(),
    result: t.string(),
  }
);

const investigation = table(
  { name: 'investigation', indexes: [{ accessor: 'byIdentity', algorithm: 'btree', columns: ['identityId'] }] },
  {
    id: t.string().primaryKey(),
    identityId: t.string(),
    identityName: t.string(),
    status: t.string(),
    startedAt: t.string(),
    completedAt: t.option(t.string()),
    requestedBy: t.string(),
    findings: t.array(finding),
    aiSummary: t.option(t.string()),
    recommendedAction: t.option(t.string()),
    source: t.string(),
    // Columns below were added after the first publish. They carry defaults so
    // SpacetimeDB can auto-migrate existing rows. `findingBases[i]` is the
    // basis ("confirmed" | "inferred" | "unknown") of `findings[i]`: the
    // nested Finding type can't gain a field without a breaking migration.
    riskScore: t.u32().default(0),
    riskLevel: t.string().default(''),
    riskFactors: t.array(t.string()).default([]),
    findingBases: t.array(t.string()).default([]),
    toolTrace: t.array(toolTraceEntry).default([]),
  }
);

const remediationPlan = table(
  { name: 'remediation_plan', indexes: [{ accessor: 'byIdentity', algorithm: 'btree', columns: ['identityId'] }] },
  {
    id: t.string().primaryKey(),
    identityId: t.string(),
    identityName: t.string(),
    investigationId: t.option(t.string()),
    action: t.string(),
    justification: t.string(),
    steps: t.array(remediationStep),
    status: t.string(),
    createdAt: t.string(),
    simulatedAt: t.option(t.string()),
    // Added after the first publish with defaults so existing rows auto-migrate.
    decidedAt: t.option(t.string()).default(undefined),
    decidedBy: t.option(t.string()).default(undefined),
  }
);

const auditEvent = table(
  { name: 'audit_event', indexes: [{ accessor: 'byTimestamp', algorithm: 'btree', columns: ['timestamp'] }] },
  {
    id: t.string().primaryKey(),
    timestamp: t.string(),
    action: t.string(),
    actor: t.string(),
    identityId: t.option(t.string()),
    identityName: t.option(t.string()),
    investigationId: t.option(t.string()),
    remediationId: t.option(t.string()),
    details: t.string(),
  }
);

// Progress events for one running investigation (what the agent is doing right now).
const investigationEvent = table(
  { name: 'investigation_event', indexes: [{ accessor: 'byInvestigation', algorithm: 'btree', columns: ['investigationId'] }] },
  {
    seq: t.u64().primaryKey().autoInc(),
    investigationId: t.string(),
    timestamp: t.string(),
    eventType: t.string(),
    stage: t.string(),
    toolName: t.option(t.string()),
    status: t.string(),
    message: t.string(),
    details: t.string(),
  }
);

// Live Security Activity feed. Rows are inserted inside the reducer that performs the state
// change they describe, so an event can neither be lost nor invented.
const securityEvent = table(
  { name: 'security_event' },
  {
    seq: t.u64().primaryKey().autoInc(),
    id: t.string().unique(),
    timestamp: t.string(),
    kind: t.string(),
    type: t.string(),
    severity: t.option(t.string()),
    identityId: t.option(t.string()),
    identityName: t.option(t.string()),
    investigationId: t.option(t.string()),
    remediationId: t.option(t.string()),
    source: t.string(),
    actor: t.string(),
    summary: t.string(),
    details: t.string(),
  }
);

// Identities allowed to call reducers and read data. Private, and no reducer writes it: only the
// database owner can add or remove rows (owner-only SQL DML via the CLI), see spacetime/scripts.
const authorizedCaller = table(
  { name: 'authorized_caller' },
  {
    identity: t.identity().primaryKey(),
    label: t.string(),
    addedAt: t.string(),
  }
);

const spacetimedb = schema({
  machineIdentity,
  permissionGrant,
  identityDependency,
  credentialMetadata,
  usageEvent,
  investigation,
  remediationPlan,
  auditEvent,
  investigationEvent,
  securityEvent,
  authorizedCaller,
});

export default spacetimedb;

const SUMMARY_MAX = 140;

function preview(text: string): string {
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 1)}…`;
}

interface SecurityEventInput {
  id: string;
  timestamp: string;
  kind: 'observed' | 'ai-finding' | 'user-action';
  type: string;
  severity?: string;
  identityId?: string;
  identityName?: string;
  investigationId?: string;
  remediationId?: string;
  source: string;
  actor: string;
  summary: string;
  details: string;
}

/** Idempotent on the deterministic `id`: re-running the same state change never duplicates the event. */
function emitSecurityEvent(ctx: { db: any }, e: SecurityEventInput): void {
  if (ctx.db.securityEvent.id.find(e.id)) return;
  ctx.db.securityEvent.insert({
    seq: 0n,
    id: e.id,
    timestamp: e.timestamp,
    kind: e.kind,
    type: e.type,
    severity: e.severity,
    identityId: e.identityId,
    identityName: e.identityName,
    investigationId: e.investigationId,
    remediationId: e.remediationId,
    source: e.source,
    actor: e.actor,
    summary: preview(e.summary),
    details: e.details,
  });
}

/** True only for identities the database owner registered in `authorizedCaller` (the Worker's service identity). */
function isAuthorized(ctx: { sender: unknown; db: any }): boolean {
  return ctx.db.authorizedCaller.identity.find(ctx.sender) != null;
}

/** Every reducer starts with this. The message is deliberately generic so callers learn nothing about why. */
function requireWorker(ctx: { sender: unknown; db: any }): void {
  if (!isAuthorized(ctx)) throw new SenderError('Not authorized.');
}

// Seed reducers: the only way to write rows into the five "static inventory"
// tables, since nothing in the app creates/edits machine identities today.
// The Worker calls these once (if the tables are empty) to bootstrap data
// that previously lived in workers/api/src/data.ts.

export const seedIdentity = spacetimedb.reducer(
  {
    id: t.string(),
    name: t.string(),
    type: t.string(),
    owner: t.string(),
    team: t.string(),
    environment: t.string(),
    status: t.string(),
    riskLevel: t.string(),
    riskScore: t.u32(),
    createdAt: t.string(),
    lastUsedAt: t.option(t.string()),
    tags: t.array(t.string()),
    description: t.string(),
  },
  (ctx, fields) => {
    requireWorker(ctx);
    ctx.db.machineIdentity.insert({ ...fields, lastUsedAt: fields.lastUsedAt ?? undefined });
  }
);

export const seedPermission = spacetimedb.reducer(
  {
    id: t.string(),
    identityId: t.string(),
    resource: t.string(),
    scope: t.string(),
    grantedAt: t.string(),
    grantedBy: t.string(),
  },
  (ctx, fields) => {
    requireWorker(ctx);
    ctx.db.permissionGrant.insert(fields);
  }
);

export const seedDependency = spacetimedb.reducer(
  {
    id: t.string(),
    identityId: t.string(),
    name: t.string(),
    kind: t.string(),
    relationship: t.string(),
  },
  (ctx, fields) => {
    requireWorker(ctx);
    ctx.db.identityDependency.insert(fields);
  }
);

export const seedCredential = spacetimedb.reducer(
  {
    id: t.string(),
    identityId: t.string(),
    kind: t.string(),
    storageLocation: t.string(),
    maskedPreview: t.string(),
    createdAt: t.string(),
    lastRotatedAt: t.option(t.string()),
    expiresAt: t.option(t.string()),
  },
  (ctx, fields) => {
    requireWorker(ctx);
    ctx.db.credentialMetadata.insert({
      ...fields,
      lastRotatedAt: fields.lastRotatedAt ?? undefined,
      expiresAt: fields.expiresAt ?? undefined,
    });
  }
);

export const seedUsageEvent = spacetimedb.reducer(
  {
    id: t.string(),
    identityId: t.string(),
    timestamp: t.string(),
    action: t.string(),
    source: t.string(),
    result: t.string(),
  },
  (ctx, fields) => {
    requireWorker(ctx);
    ctx.db.usageEvent.insert(fields);
  }
);

/** Creates an investigation row in "running" status. The caller (Worker) supplies the id. */
export const startInvestigation = spacetimedb.reducer(
  {
    id: t.string(),
    identityId: t.string(),
    identityName: t.string(),
    requestedBy: t.string(),
    startedAt: t.string(),
    source: t.string(),
  },
  (ctx, { id, identityId, identityName, requestedBy, startedAt, source }) => {
    requireWorker(ctx);
    // Atomic version of the Worker's cost-abuse guard (parallel requests can't slip past a check-then-insert).
    // Compares the caller-supplied timestamps only, so it stays deterministic. Keep in sync with the Worker's 200s.
    const startedMs = Date.parse(startedAt);
    for (const other of ctx.db.investigation.byIdentity.filter(identityId)) {
      if (other.status === 'running' && startedMs - Date.parse(other.startedAt) < 200_000) {
        throw new SenderError(`An investigation of ${identityId} is already running`);
      }
    }
    ctx.db.investigation.insert({
      id,
      identityId,
      identityName,
      status: 'running',
      startedAt,
      completedAt: undefined,
      requestedBy,
      findings: [],
      aiSummary: undefined,
      recommendedAction: undefined,
      source,
      riskScore: 0,
      riskLevel: '',
      riskFactors: [],
      findingBases: [],
      toolTrace: [],
    });
    ctx.db.auditEvent.insert({
      id: `${id}-started`,
      timestamp: startedAt,
      action: 'investigation-started',
      actor: requestedBy,
      identityId,
      identityName,
      investigationId: id,
      remediationId: undefined,
      details: `Investigation started for ${identityName}.`,
    });
    emitSecurityEvent(ctx, {
      id: `${id}-started`,
      timestamp: startedAt,
      kind: 'user-action',
      type: 'investigation-started',
      identityId,
      identityName,
      investigationId: id,
      source: 'operator',
      actor: requestedBy,
      summary: `Investigation started for ${identityName}`,
      details: `${requestedBy} started an investigation of ${identityName} (${identityId}) using the ${source} analyst.`,
    });
  }
);

/** Appends one finding to a running investigation. Called as the agent records each finding. */
export const recordFinding = spacetimedb.reducer(
  {
    investigationId: t.string(),
    id: t.string(),
    category: t.string(),
    severity: t.string(),
    basis: t.string(),
    description: t.string(),
    evidence: t.string(),
    recordedAt: t.string(),
  },
  (ctx, { investigationId, id, category, severity, basis, description, evidence, recordedAt }) => {
    requireWorker(ctx);
    const existing = ctx.db.investigation.id.find(investigationId);
    if (!existing || existing.status !== 'running') return;

    ctx.db.investigation.id.update({
      ...existing,
      findings: [...existing.findings, { id, category, severity, description, evidence }],
      findingBases: [...existing.findingBases, basis],
    });
    emitSecurityEvent(ctx, {
      id: `${investigationId}-finding-${id}`,
      timestamp: recordedAt,
      kind: 'ai-finding',
      type: 'finding-discovered',
      severity,
      identityId: existing.identityId,
      identityName: existing.identityName,
      investigationId,
      source: existing.source,
      actor: existing.source === 'mock' ? 'nemotron-ai (mock)' : 'nemotron-ai',
      summary: `[${basis}] ${description}`,
      details: `Category: ${category}\nSeverity: ${severity}\nBasis: ${basis}\nDescription: ${description}\nEvidence: ${evidence}`,
    });
  }
);

/** Finalizes a running investigation. Findings were already appended via recordFinding. */
export const completeInvestigation = spacetimedb.reducer(
  {
    investigationId: t.string(),
    completedAt: t.string(),
    aiSummary: t.string(),
    recommendedAction: t.string(),
    riskScore: t.u32(),
    riskLevel: t.string(),
    riskFactors: t.array(t.string()),
    toolTrace: t.array(toolTraceEntry),
    actor: t.string(),
  },
  (ctx, { investigationId, completedAt, aiSummary, recommendedAction, riskScore, riskLevel, riskFactors, toolTrace, actor }) => {
    requireWorker(ctx);
    const existing = ctx.db.investigation.id.find(investigationId);
    if (!existing) return;

    ctx.db.investigation.id.update({
      ...existing,
      status: 'completed',
      completedAt,
      aiSummary,
      recommendedAction,
      riskScore,
      riskLevel,
      riskFactors,
      toolTrace,
    });
    ctx.db.auditEvent.insert({
      id: `${investigationId}-completed`,
      timestamp: completedAt,
      action: 'investigation-completed',
      actor,
      identityId: existing.identityId,
      identityName: existing.identityName,
      investigationId,
      remediationId: undefined,
      details: `Investigation completed with ${existing.findings.length} finding(s), risk ${riskScore} (${riskLevel}): recommend ${recommendedAction}.`,
    });
    emitSecurityEvent(ctx, {
      id: `${investigationId}-completed`,
      timestamp: completedAt,
      kind: 'ai-finding',
      type: 'investigation-completed',
      severity: riskLevel,
      identityId: existing.identityId,
      identityName: existing.identityName,
      investigationId,
      source: existing.source,
      actor,
      summary: `Investigation of ${existing.identityName} completed: risk ${riskScore} (${riskLevel}), recommend ${recommendedAction}`,
      details: [
        `Findings recorded: ${existing.findings.length}`,
        `Risk score (computed by the backend, not the AI): ${riskScore}/100`,
        `Risk level: ${riskLevel}`,
        `Risk factors: ${riskFactors.length > 0 ? riskFactors.join('; ') : 'none'}`,
        `Recommended action: ${recommendedAction} (proposal only, requires human approval)`,
      ].join('\n'),
    });
  }
);

/** Marks a running investigation as failed. Keeps any findings recorded before the failure. */
export const failInvestigation = spacetimedb.reducer(
  {
    investigationId: t.string(),
    completedAt: t.string(),
    reason: t.string(),
    toolTrace: t.array(toolTraceEntry),
    actor: t.string(),
  },
  (ctx, { investigationId, completedAt, reason, toolTrace, actor }) => {
    requireWorker(ctx);
    const existing = ctx.db.investigation.id.find(investigationId);
    if (!existing) return;

    ctx.db.investigation.id.update({ ...existing, status: 'failed', completedAt, aiSummary: reason, toolTrace });
    ctx.db.auditEvent.insert({
      id: `${investigationId}-failed`,
      timestamp: completedAt,
      action: 'investigation-failed',
      actor,
      identityId: existing.identityId,
      identityName: existing.identityName,
      investigationId,
      remediationId: undefined,
      details: `Investigation failed: ${reason}`,
    });
    // 'medium': a failed run is a coverage gap (the identity was NOT assessed), not a finding about the identity itself.
    emitSecurityEvent(ctx, {
      id: `${investigationId}-failed`,
      timestamp: completedAt,
      kind: 'observed',
      type: 'investigation-failed',
      severity: 'medium',
      identityId: existing.identityId,
      identityName: existing.identityName,
      investigationId,
      source: 'worker',
      actor,
      summary: `Investigation of ${existing.identityName} failed`,
      details: reason,
    });
  }
);

/** Proposes a retirement/rotation/migration plan, usually following an investigation. */
export const proposeRemediation = spacetimedb.reducer(
  {
    id: t.string(),
    identityId: t.string(),
    identityName: t.string(),
    investigationId: t.option(t.string()),
    action: t.string(),
    justification: t.string(),
    steps: t.array(remediationStep),
    createdAt: t.string(),
    actor: t.string(),
  },
  (ctx, { id, identityId, identityName, investigationId, action, justification, steps, createdAt, actor }) => {
    requireWorker(ctx);
    ctx.db.remediationPlan.insert({
      id,
      identityId,
      identityName,
      investigationId,
      action,
      justification,
      steps,
      status: 'proposed',
      createdAt,
      simulatedAt: undefined,
      decidedAt: undefined,
      decidedBy: undefined,
    });
    ctx.db.auditEvent.insert({
      id: `${id}-proposed`,
      timestamp: createdAt,
      action: 'remediation-proposed',
      actor,
      identityId,
      identityName,
      investigationId,
      remediationId: id,
      details: `${action} plan proposed for ${identityName}.`,
    });
    const byAi = actor.startsWith('nemotron-ai');
    emitSecurityEvent(ctx, {
      id: `${id}-proposed`,
      timestamp: createdAt,
      kind: byAi ? 'ai-finding' : 'user-action',
      type: 'remediation-proposed',
      identityId,
      identityName,
      investigationId,
      remediationId: id,
      source: byAi ? (actor.includes('(mock)') ? 'mock' : 'nemotron') : 'operator',
      actor,
      summary: `${action} plan proposed for ${identityName}`,
      details: [
        `Action: ${action}`,
        `Justification: ${justification}`,
        'Steps:',
        ...steps.map((st) => `  ${st.order}. ${st.description}`),
        'Status: proposed. Awaiting human approval; no credential has been changed.',
      ].join('\n'),
    });
  }
);

function requirePlan(ctx: { db: any }, planId: string, expected: string, verb: string) {
  const plan = ctx.db.remediationPlan.id.find(planId);
  if (!plan) throw new SenderError(`Remediation plan ${planId} not found`);
  if (plan.status !== expected) throw new SenderError(`Cannot ${verb} a plan in status "${plan.status}"; it must be "${expected}"`);
  return plan;
}

/** Human approval of a proposed plan. Approval alone changes nothing in any real system. */
export const approveRemediation = spacetimedb.reducer(
  { planId: t.string(), decidedAt: t.string(), actor: t.string() },
  (ctx, { planId, decidedAt, actor }) => {
    requireWorker(ctx);
    const plan = requirePlan(ctx, planId, 'proposed', 'approve');
    ctx.db.remediationPlan.id.update({ ...plan, status: 'approved', decidedAt, decidedBy: actor });
    ctx.db.auditEvent.insert({
      id: `${planId}-approved`,
      timestamp: decidedAt,
      action: 'remediation-approved',
      actor,
      identityId: plan.identityId,
      identityName: plan.identityName,
      investigationId: plan.investigationId,
      remediationId: planId,
      details: `"${plan.action}" plan approved by ${actor}. Approval does not execute anything; only a dry-run simulation is available.`,
    });
    emitSecurityEvent(ctx, {
      id: `${planId}-approved`,
      timestamp: decidedAt,
      kind: 'user-action',
      type: 'remediation-approved',
      identityId: plan.identityId,
      identityName: plan.identityName,
      investigationId: plan.investigationId,
      remediationId: planId,
      source: 'operator',
      actor,
      summary: `${actor} approved the ${plan.action} plan for ${plan.identityName}`,
      details: `"${plan.action}" plan for ${plan.identityName} approved by ${actor}. Approval does not execute anything; only a dry-run simulation is available.`,
    });
  }
);

/** Human rejection of a proposed plan. */
export const rejectRemediation = spacetimedb.reducer(
  { planId: t.string(), decidedAt: t.string(), actor: t.string() },
  (ctx, { planId, decidedAt, actor }) => {
    requireWorker(ctx);
    const plan = requirePlan(ctx, planId, 'proposed', 'reject');
    ctx.db.remediationPlan.id.update({ ...plan, status: 'rejected', decidedAt, decidedBy: actor });
    ctx.db.auditEvent.insert({
      id: `${planId}-rejected`,
      timestamp: decidedAt,
      action: 'remediation-rejected',
      actor,
      identityId: plan.identityId,
      identityName: plan.identityName,
      investigationId: plan.investigationId,
      remediationId: planId,
      details: `"${plan.action}" plan rejected by ${actor}. No credential was changed.`,
    });
    emitSecurityEvent(ctx, {
      id: `${planId}-rejected`,
      timestamp: decidedAt,
      kind: 'user-action',
      type: 'remediation-rejected',
      identityId: plan.identityId,
      identityName: plan.identityName,
      investigationId: plan.investigationId,
      remediationId: planId,
      source: 'operator',
      actor,
      summary: `${actor} rejected the ${plan.action} plan for ${plan.identityName}`,
      details: `"${plan.action}" plan for ${plan.identityName} rejected by ${actor}. No credential was changed.`,
    });
  }
);

/** Marks an APPROVED remediation plan as simulated. This never touches a real credential. */
export const simulateRemediation = spacetimedb.reducer(
  { planId: t.string(), simulatedAt: t.string(), actor: t.string() },
  (ctx, { planId, simulatedAt, actor }) => {
    requireWorker(ctx);
    const plan = requirePlan(ctx, planId, 'approved', 'simulate');

    ctx.db.remediationPlan.id.update({ ...plan, status: 'simulated', simulatedAt });
    const details = `Dry-run simulation completed for "${plan.action}" plan. No live credential was touched.`;
    ctx.db.auditEvent.insert({
      id: `${planId}-simulated-${simulatedAt}`,
      timestamp: simulatedAt,
      action: 'remediation-simulated',
      actor,
      identityId: plan.identityId,
      identityName: plan.identityName,
      investigationId: plan.investigationId,
      remediationId: planId,
      details,
    });
    emitSecurityEvent(ctx, {
      id: `${planId}-simulated`,
      timestamp: simulatedAt,
      kind: 'user-action',
      type: 'remediation-simulated',
      identityId: plan.identityId,
      identityName: plan.identityName,
      investigationId: plan.investigationId,
      remediationId: planId,
      source: 'operator',
      actor,
      summary: `Dry run of the ${plan.action} plan for ${plan.identityName}`,
      details,
    });
  }
);

/** Appends one progress event for a running investigation. `seq` is assigned by the database. */
export const recordInvestigationEvent = spacetimedb.reducer(
  {
    investigationId: t.string(),
    timestamp: t.string(),
    eventType: t.string(),
    stage: t.string(),
    toolName: t.option(t.string()),
    status: t.string(),
    message: t.string(),
    details: t.string(),
  },
  (ctx, { investigationId, timestamp, eventType, stage, toolName, status, message, details }) => {
    requireWorker(ctx);
    if (!ctx.db.investigation.id.find(investigationId)) return;
    ctx.db.investigationEvent.insert({ seq: 0n, investigationId, timestamp, eventType, stage, toolName, status, message, details });
  }
);

// Read access. Every table above is private, so a client cannot query it. The Worker reads through
// these views instead: they are queryable by anyone, but return rows only when the caller's identity
// is registered in `authorizedCaller`; an anonymous or unregistered caller gets zero rows. There is
// one per table, named `v_<table>`, and the Worker's SQL reads from them.

export const vMachineIdentity = spacetimedb.view(
  { name: 'v_machine_identity', public: true },
  t.array(machineIdentity.rowType),
  (ctx) => (isAuthorized(ctx) ? Array.from(ctx.db.machineIdentity.iter()) : [])
);

export const vPermissionGrant = spacetimedb.view(
  { name: 'v_permission_grant', public: true },
  t.array(permissionGrant.rowType),
  (ctx) => (isAuthorized(ctx) ? Array.from(ctx.db.permissionGrant.iter()) : [])
);

export const vIdentityDependency = spacetimedb.view(
  { name: 'v_identity_dependency', public: true },
  t.array(identityDependency.rowType),
  (ctx) => (isAuthorized(ctx) ? Array.from(ctx.db.identityDependency.iter()) : [])
);

export const vCredentialMetadata = spacetimedb.view(
  { name: 'v_credential_metadata', public: true },
  t.array(credentialMetadata.rowType),
  (ctx) => (isAuthorized(ctx) ? Array.from(ctx.db.credentialMetadata.iter()) : [])
);

export const vUsageEvent = spacetimedb.view(
  { name: 'v_usage_event', public: true },
  t.array(usageEvent.rowType),
  (ctx) => (isAuthorized(ctx) ? Array.from(ctx.db.usageEvent.iter()) : [])
);

export const vInvestigation = spacetimedb.view(
  { name: 'v_investigation', public: true },
  t.array(investigation.rowType),
  (ctx) => (isAuthorized(ctx) ? Array.from(ctx.db.investigation.iter()) : [])
);

export const vRemediationPlan = spacetimedb.view(
  { name: 'v_remediation_plan', public: true },
  t.array(remediationPlan.rowType),
  (ctx) => (isAuthorized(ctx) ? Array.from(ctx.db.remediationPlan.iter()) : [])
);

export const vAuditEvent = spacetimedb.view(
  { name: 'v_audit_event', public: true },
  t.array(auditEvent.rowType),
  (ctx) => (isAuthorized(ctx) ? Array.from(ctx.db.auditEvent.iter()) : [])
);

export const vInvestigationEvent = spacetimedb.view(
  { name: 'v_investigation_event', public: true },
  t.array(investigationEvent.rowType),
  (ctx) => (isAuthorized(ctx) ? Array.from(ctx.db.investigationEvent.iter()) : [])
);

export const vSecurityEvent = spacetimedb.view(
  { name: 'v_security_event', public: true },
  t.array(securityEvent.rowType),
  (ctx) => (isAuthorized(ctx) ? Array.from(ctx.db.securityEvent.iter()) : [])
);
