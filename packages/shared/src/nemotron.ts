import type { InvestigationFinding } from './investigation.js';
import type { RemediationAction } from './remediation.js';

/** Input context handed to the AI provider to produce an investigation result. */
export interface NemotronInvestigationInput {
  identityName: string;
  identityType: string;
  owner: string;
  environment: string;
  lastUsedAt: string | null;
  permissionsSummary: string[];
  dependenciesSummary: string[];
  recentUsageSummary: string[];
}

export interface NemotronInvestigationOutput {
  findings: InvestigationFinding[];
  summary: string;
  recommendedAction: RemediationAction | 'no-action';
}

/**
 * Implemented once for the real NVIDIA Nemotron API and once for local mock
 * responses, so the worker can run fully without a configured API key.
 */
export interface NemotronProvider {
  readonly name: 'nemotron' | 'mock';
  investigate(input: NemotronInvestigationInput): Promise<NemotronInvestigationOutput>;
}
