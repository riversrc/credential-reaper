export type InvestigationStatus = 'queued' | 'running' | 'completed' | 'failed';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * How well a finding is supported by retrieved evidence:
 * - confirmed: directly stated by data the agent retrieved through a backend tool.
 * - inferred: a risk reasoned from retrieved data, but not directly stated by it.
 * - unknown: something the available data cannot answer.
 */
export type FindingBasis = 'confirmed' | 'inferred' | 'unknown';

export interface InvestigationFinding {
  id: string;
  category: string;
  severity: FindingSeverity;
  basis: FindingBasis;
  description: string;
  evidence: string;
}

/** Computed deterministically by the Worker from retrieved data — never by the AI. */
export interface RiskAssessment {
  score: number; // 0-100
  level: 'critical' | 'high' | 'medium' | 'low';
  factors: string[];
}

/** One backend tool call made during an investigation (arguments and results are not stored). */
export interface ToolTraceEntry {
  seq: number;
  tool: string;
  status: 'ok' | 'rejected' | 'error';
  summary: string;
  durationMs: number;
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
  riskAssessment: RiskAssessment | null;
  toolTrace: ToolTraceEntry[];
  /** Which AI provider produced this result: real Nemotron call or local mock. */
  source: 'nemotron' | 'mock';
}

export interface StartInvestigationRequest {
  identityId: string;
  requestedBy: string;
  /** Optional client-generated UUID v4 so the client can watch this run's events while the request is in flight. */
  investigationId?: string;
}
