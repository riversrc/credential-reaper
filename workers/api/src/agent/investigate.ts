// Orchestrates one investigation: persists the running row, hands the
// provider a validated toolbox, then finalizes using values the backend
// computed itself (risk) plus what the agent legitimately recorded.
import type { Investigation, InvestigationEvent, InvestigationStage } from '@credential-reaper/shared';
import { LIMITS } from '../providers/nemotron.js';
import type { NemotronProvider } from '../providers/types.js';
import type { SpacetimeEnv } from '../spacetime/client.js';
import { completeInvestigationRow, failInvestigationRow, recordInvestigationEventRow, startInvestigationRow } from '../spacetime/repository.js';
import { createToolbox, RETRIEVAL_TOOLS, type ToolboxEvent } from './tools.js';

const STAGE_RANK: Record<InvestigationStage, number> = { waiting: 0, gathering: 1, analyzing: 2, completing: 3 };
const STAGE_MESSAGES: Record<InvestigationStage, string> = {
  waiting: 'Waiting for the analyst to start',
  gathering: 'Gathering evidence from recorded data',
  analyzing: 'Analyzing evidence and recording findings',
  completing: 'Computing risk and saving results',
};

type EventDraft = Pick<InvestigationEvent, 'eventType' | 'toolName' | 'status' | 'message' | 'details'>;

/**
 * Writes progress events for one run. Stage changes are emitted only when the code really
 * reaches them, and only forward. A failed write is logged (ids only) and swallowed: activity
 * reporting must never fail or alter the investigation.
 */
function createActivity(env: SpacetimeEnv, investigationId: string, maxToolCalls: number | null) {
  let stage: InvestigationStage = 'waiting';

  async function write(draft: EventDraft): Promise<void> {
    try {
      await recordInvestigationEventRow(env, { investigationId, timestamp: new Date().toISOString(), stage, ...draft });
    } catch {
      console.log(JSON.stringify({ event: 'activity_event_failed', investigationId, type: draft.eventType }));
    }
  }

  async function enter(next: InvestigationStage): Promise<void> {
    if (STAGE_RANK[next] <= STAGE_RANK[stage]) return;
    stage = next;
    await write({ eventType: 'stage-changed', toolName: null, status: 'running', message: STAGE_MESSAGES[next], details: '' });
  }

  const callCounter = (seq: number) => (maxToolCalls === null ? `Tool call ${seq}.` : `Tool call ${seq} of at most ${maxToolCalls}.`);

  return {
    write,
    enter,
    async onToolboxEvent(e: ToolboxEvent): Promise<void> {
      if (e.type === 'tool-started') {
        if (e.tool !== null) await enter(e.analysis ? 'analyzing' : (RETRIEVAL_TOOLS as readonly string[]).includes(e.tool) ? 'gathering' : stage);
        await write({ eventType: 'tool-started', toolName: e.tool, status: 'running', message: e.message, details: callCounter(e.seq) });
      } else if (e.type === 'tool-finished') {
        const status = e.status === 'ok' ? 'completed' : e.status === 'rejected' ? 'rejected' : 'failed';
        await write({ eventType: 'tool-completed', toolName: e.tool, status, message: e.message, details: `${callCounter(e.seq)} ${e.durationMs} ms. ${e.detail}` });
      } else {
        await write({
          eventType: 'finding-recorded',
          toolName: 'record_finding',
          status: 'completed',
          message: `Finding ${e.number} recorded`,
          details: `${e.severity} ${e.basis} ${e.category} finding.`,
        });
      }
    },
  };
}

export class InvestigationFailedError extends Error {
  constructor(
    message: string,
    readonly investigationId: string
  ) {
    super(message);
  }
}

export async function runInvestigation(
  env: SpacetimeEnv,
  provider: NemotronProvider,
  input: { identity: { id: string; name: string }; requestedBy: string; investigationId?: string }
): Promise<Investigation> {
  const { identity, requestedBy } = input;
  const investigationId = input.investigationId ?? crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const actor = provider.name === 'nemotron' ? `nemotron-ai (${provider.model})` : 'nemotron-ai (mock)';
  const log = (event: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, investigationId, identityId: identity.id, provider: provider.name, ...extra }));

  await startInvestigationRow(env, {
    id: investigationId,
    identityId: identity.id,
    identityName: identity.name,
    requestedBy,
    startedAt,
    source: provider.name,
  });
  log('investigation_started', { model: provider.model });

  // The limit only exists for the real provider's loop; the scripted mock has no tool-call cap to report.
  const activity = createActivity(env, investigationId, provider.name === 'nemotron' ? LIMITS.maxToolCalls : null);
  await activity.write({ eventType: 'investigation-started', toolName: null, status: 'running', message: 'Investigation started', details: `Analyst: ${provider.name}.` });

  const toolbox = createToolbox(env, { investigationId, identityId: identity.id, identityName: identity.name }, { onEvent: activity.onToolboxEvent });

  try {
    const outcome = await provider.investigate({
      investigationId,
      identityId: identity.id,
      identityName: identity.name,
      toolbox,
    });

    const { findings, recommendation, trace } = toolbox.state;
    if (findings.length === 0) {
      throw new Error(outcome.stoppedEarly ? `Stopped early (${outcome.stoppedEarly}) before recording any findings` : 'The agent finished without recording any findings');
    }

    await activity.enter('completing');
    const risk = await toolbox.computeRisk();
    const notes: string[] = [];
    if (outcome.stoppedEarly) notes.push(`Stopped early: ${outcome.stoppedEarly}.`);
    if (!recommendation) notes.push(`The agent did not recommend a remediation; showing the deterministic suggestion (${risk.suggestedAction}) for human review.`);
    const aiSummary = [outcome.summary, ...notes].filter(Boolean).join(' ') || 'No summary was produced.';
    const recommendedAction = recommendation?.action ?? risk.suggestedAction;
    const completedAt = new Date().toISOString();

    await completeInvestigationRow(env, {
      investigationId,
      completedAt,
      aiSummary,
      recommendedAction,
      riskScore: risk.score,
      riskLevel: risk.level,
      riskFactors: risk.factors,
      toolTrace: trace,
      actor,
    });
    await activity.write({
      eventType: 'investigation-completed',
      toolName: null,
      status: 'completed',
      message: 'Investigation completed',
      details: `${findings.length} finding(s) recorded; ${trace.length} tool call(s).`,
    });
    log('investigation_completed', { findings: findings.length, toolCalls: trace.length, riskScore: risk.score, recommendedAction, stoppedEarly: outcome.stoppedEarly });

    return {
      id: investigationId,
      identityId: identity.id,
      identityName: identity.name,
      status: 'completed',
      startedAt,
      completedAt,
      requestedBy,
      findings,
      aiSummary,
      recommendedAction,
      riskAssessment: { score: risk.score, level: risk.level, factors: risk.factors },
      toolTrace: trace,
      source: provider.name,
    };
  } catch (e) {
    const reason = (e as Error).message.slice(0, 500);
    log('investigation_failed', { reason, toolCalls: toolbox.state.trace.length });
    await failInvestigationRow(env, {
      investigationId,
      completedAt: new Date().toISOString(),
      reason: `Investigation failed: ${reason}`,
      toolTrace: toolbox.state.trace,
      actor,
    }).catch((persistError) => log('investigation_fail_persist_error', { reason: (persistError as Error).message.slice(0, 200) }));
    // The reason text stays in the investigation record; events carry no provider-originated text.
    await activity.write({ eventType: 'investigation-failed', toolName: null, status: 'failed', message: 'Investigation failed', details: 'See the investigation record for the failure reason.' });
    throw new InvestigationFailedError(reason, investigationId);
  }
}
