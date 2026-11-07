export type InvestigationStatus = 'queued' | 'running' | 'completed' | 'failed';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface InvestigationFinding {
  id: string;
  category: string;
  severity: FindingSeverity;
  description: string;
  evidence: string;
}

export interface Investigation {
  id: string;
  identityId: string;
  identityName: string;
  status: InvestigationStatus;
  startedAt: string;
  completedAt: string | null;
  requestedBy: string;
  findings: InvestigationFinding[];
  aiSummary: string | null;
  recommendedAction: 'retire' | 'rotate' | 'migrate' | 'monitor' | 'no-action' | null;
  /** Which AI provider produced this result: real Nemotron call or local mock. */
  source: 'nemotron' | 'mock';
}

export interface StartInvestigationRequest {
  identityId: string;
  requestedBy: string;
}
