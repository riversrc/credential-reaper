import type { InvestigationFinding, RiskAssessment, ToolTraceEntry } from './investigation.js';
import type { RemediationAction } from './remediation.js';

/** Everything the Worker records about a finished (or stopped) investigation run. */
export interface NemotronInvestigationOutput {
  findings: InvestigationFinding[];
  summary: string;
  recommendedAction: RemediationAction | 'no-action';
  riskAssessment: RiskAssessment;
  toolTrace: ToolTraceEntry[];
}
