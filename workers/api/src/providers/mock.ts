import type { NemotronInvestigationInput, NemotronInvestigationOutput, NemotronProvider } from '@credential-reaper/shared';

/**
 * Deterministic stand-in for the real Nemotron call. Used automatically
 * whenever NVIDIA_API_KEY is not configured, so the API — and the demo —
 * work fully offline.
 */
export const mockNemotronProvider: NemotronProvider = {
  name: 'mock',
  async investigate(input: NemotronInvestigationInput): Promise<NemotronInvestigationOutput> {
    const noOwner = !input.owner || input.owner.toLowerCase() === 'unassigned';
    const dormant =
      input.lastUsedAt === null ||
      new Date(input.lastUsedAt).getTime() < Date.now() - 1000 * 60 * 60 * 24 * 180;

    const findings: NemotronInvestigationOutput['findings'] = [];
    if (noOwner) {
      findings.push({
        id: crypto.randomUUID(),
        category: 'ownership',
        severity: 'critical',
        description: 'No active owner on record for this identity.',
        evidence: `owner = "${input.owner}"`,
      });
    }
    if (dormant) {
      findings.push({
        id: crypto.randomUUID(),
        category: 'dormancy',
        severity: 'high',
        description: 'No recent usage observed.',
        evidence: input.lastUsedAt ? `last used ${input.lastUsedAt}` : 'no usage events on record',
      });
    }
    if (findings.length === 0) {
      findings.push({
        id: crypto.randomUUID(),
        category: 'risk-posture',
        severity: 'info',
        description: `${input.identityName} appears actively used with no immediate concerns.`,
        evidence: `type=${input.identityType}, environment=${input.environment}`,
      });
    }

    const recommendedAction = noOwner ? 'retire' : dormant ? 'rotate' : 'no-action';

    return {
      findings,
      summary: `Mock analysis of ${input.identityName}: ${
        noOwner
          ? 'identity has no active owner and should be considered for retirement.'
          : dormant
            ? 'identity shows low recent usage relative to its granted scope.'
            : 'identity appears actively used; recommend ongoing monitoring.'
      }`,
      recommendedAction,
    };
  },
};
