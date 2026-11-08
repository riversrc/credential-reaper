// Orchestrates one investigation: persists the running row, hands the
// provider a validated toolbox, then finalizes using values the backend
// computed itself (risk) plus what the agent legitimately recorded.
import type { Investigation } from '@credential-reaper/shared';
import type { NemotronProvider } from '../providers/types.js';
import type { SpacetimeEnv } from '../spacetime/client.js';
import { completeInvestigationRow, failInvestigationRow, startInvestigationRow } from '../spacetime/repository.js';
import { createToolbox } from './tools.js';

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
  input: { identity: { id: string; name: string }; requestedBy: string }
): Promise<Investigation> {
  const { identity, requestedBy } = input;
  const investigationId = crypto.randomUUID();
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

  const toolbox = createToolbox(env, { investigationId, identityId: identity.id, identityName: identity.name });

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
    throw new InvestigationFailedError(reason, investigationId);
  }
}
