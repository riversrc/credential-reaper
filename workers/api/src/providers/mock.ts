import type { FindingBasis, FindingSeverity } from '@credential-reaper/shared';
import type { ToolResult } from '../agent/tools.js';
import type { AgentOutcome, InvestigationRun, NemotronProvider } from './types.js';

type Data = Record<string, any>;

/**
 * Scripted stand-in for the Nemotron agent, used whenever NVIDIA_API_KEY is
 * unset. It makes the same tool calls through the same validated toolbox as
 * the real agent (so the data is real SpacetimeDB data), but decides what to
 * record with fixed rules instead of a model.
 */
export const mockNemotronProvider: NemotronProvider = {
  name: 'mock',
  model: 'scripted-mock',
  async investigate(run: InvestigationRun): Promise<AgentOutcome> {
    const { toolbox, identityId } = run;
    const args = { identity_id: identityId };

    const fetchData = async (tool: string, extra: Record<string, unknown> = {}): Promise<Data> => {
      const result: ToolResult = await toolbox.call(tool, { ...args, ...extra });
      if (!result.ok) throw new Error(`${tool} failed: ${result.error}`);
      return result.data as Data;
    };

    const details = await fetchData('get_identity_details');
    const ownership = await fetchData('get_ownership');
    const permissions = await fetchData('get_permissions');
    const dependencies = await fetchData('get_dependencies');
    const usage = await fetchData('get_usage_history');
    const risk = await fetchData('get_risk_assessment');

    const record = async (
      category: string,
      severity: FindingSeverity,
      basis: FindingBasis,
      description: string,
      evidence: string,
      sources: string[]
    ) => {
      const result = await toolbox.call('record_finding', { category, severity, basis, description, evidence, sources });
      if (!result.ok) throw new Error(`record_finding rejected: ${result.error}`);
    };

    if (ownership.ownerStatus === 'unassigned') {
      await record('ownership', 'critical', 'confirmed', 'No active owner is assigned to this identity.', `owner = "${ownership.owner}"`, ['get_ownership']);
    } else if (ownership.ownerStatus === 'external') {
      await record('ownership', 'medium', 'inferred', 'The owner is external, so accountability may lapse when their engagement ends.', `owner = "${ownership.owner}"`, ['get_ownership']);
    }
    if (ownership.ownerStatus !== 'unassigned') {
      await record('ownership', 'low', 'unknown', 'Cannot verify that the named owner is still active.', ownership.cannotVerify[0], ['get_ownership']);
    }

    const idle: number | null = usage.daysIdle;
    if (idle === null && usage.runtimeEvidenceAvailable === false) {
      await record('dormancy', 'low', 'unknown', 'Usage cannot be assessed: this identity is known only from repository declarations and no runtime data is collected.', `runtimeEvidenceAvailable = false`, ['get_usage_history']);
    } else if (idle === null) {
      await record('dormancy', 'high', 'confirmed', 'No usage has ever been recorded for this identity.', `totalEventsRecorded = ${usage.totalEventsRecorded}`, ['get_usage_history']);
    } else if (idle > 90) {
      await record('dormancy', idle > 180 ? 'high' : 'medium', 'confirmed', `No recorded use for ${idle} days.`, `lastActivityAt = ${usage.lastActivityAt}`, ['get_usage_history']);
    }

    const broad = (permissions.permissions as Data[]).find((p) => /^(admin|owner|\*)$/i.test(p.scope));
    if (broad) {
      await record('over-permissioning', 'high', 'confirmed', 'The identity holds an administrative scope.', `${broad.resource} scope = ${broad.scope}`, ['get_permissions']);
    }

    const creds = (details.credentials as Data[]) ?? [];
    const expired = creds.find((c) => c.expiresAt && new Date(c.expiresAt).getTime() < Date.now());
    if (expired) {
      await record('credential-hygiene', 'high', 'confirmed', 'A credential is past its expiry date but still on record.', `${expired.maskedPreview} expiresAt = ${expired.expiresAt}`, ['get_identity_details']);
    }
    const unrotated = creds.find((c) => !c.lastRotatedAt);
    if (unrotated) {
      await record('credential-hygiene', 'medium', 'confirmed', 'A credential has never been rotated.', `${unrotated.maskedPreview} lastRotatedAt = null`, ['get_identity_details']);
    }

    if ((dependencies.dependencies as Data[]).length === 0) {
      await record('dependencies', 'low', 'unknown', 'No dependency records exist, so it cannot be confirmed that nothing relies on this identity.', 'dependencies = []', ['get_dependencies']);
    }

    if (toolbox.state.findings.every((f) => f.basis === 'unknown')) {
      await record('risk-posture', 'info', 'confirmed', 'No concrete risk indicators were found in the retrieved data.', `risk level = ${risk.level}`, ['get_risk_assessment']);
    }

    const action = risk.suggestedAction as string;
    const result = await toolbox.call('recommend_remediation', {
      action,
      justification: `Deterministic risk score ${risk.score} (${risk.level}); ${toolbox.state.findings.length} finding(s) recorded. Proposed for human review only.`,
    });
    if (!result.ok) throw new Error(`recommend_remediation rejected: ${result.error}`);

    const line = (basis: FindingBasis) =>
      toolbox.state.findings.filter((f) => f.basis === basis).map((f) => f.description).join(' ') || 'None.';
    return {
      summary: `Mock analysis (scripted, no model). Confirmed: ${line('confirmed')} Inferred: ${line('inferred')} Unknown: ${line('unknown')}`,
    };
  },
};
