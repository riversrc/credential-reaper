import type { FindingSeverity } from './investigation.js';

/** Real phases of one investigation run. Only moves forward, and only when the code actually gets there. */
export type InvestigationStage = 'waiting' | 'gathering' | 'analyzing' | 'completing';

export type InvestigationEventType =
  | 'investigation-started'
  | 'stage-changed'
  | 'tool-started'
  | 'tool-completed'
  | 'finding-recorded'
  | 'investigation-completed'
  | 'investigation-failed';

export type InvestigationEventStatus = 'running' | 'completed' | 'failed' | 'rejected';

/**
 * Progress of one running investigation. Contains only static messages, tool names,
 * counters and the already-sanitized trace summary: never tool arguments, raw tool
 * results, prompts, model output or secrets.
 */
export interface InvestigationEvent {
  /** Monotonic, assigned by SpacetimeDB. Use as a polling / resume cursor. */
  seq: number;
  investigationId: string;
  timestamp: string;
  eventType: InvestigationEventType;
  /** Stage in effect when the event was emitted (for `stage-changed`, the stage just entered). */
  stage: InvestigationStage;
  toolName: string | null;
  status: InvestigationEventStatus;
  message: string;
  details: string;
}

export type SecurityEventKind = 'observed' | 'ai-finding' | 'user-action';

export type SecurityEventSeverity = FindingSeverity;

export type SecurityEventType =
  | 'investigation-started'
  | 'finding-discovered'
  | 'investigation-completed'
  | 'investigation-failed'
  | 'remediation-proposed'
  | 'remediation-approved'
  | 'remediation-rejected'
  | 'remediation-simulated'
  | 'remediation-pr-opened'
  | 'repo-scan-ingested';

/**
 * Live Security Activity: facts the app actually recorded or observed. Rows are written inside
 * the same reducer transaction as the state change they describe. `details` is complete and never
 * truncated; `summary` is a short preview (max 140 chars).
 */
export interface SecurityEvent {
  seq: number;
  id: string;
  timestamp: string;
  kind: SecurityEventKind;
  type: SecurityEventType;
  severity: SecurityEventSeverity | null;
  identityId: string | null;
  identityName: string | null;
  investigationId: string | null;
  remediationId: string | null;
  /** 'nemotron' | 'mock' | 'worker' | 'operator' */
  source: string;
  actor: string;
  summary: string;
  details: string;
}

/** Body accepted by the remediation approve / reject / simulate routes. */
export interface RemediationDecisionRequest {
  /** Client-supplied and unauthenticated until real auth lands. 1-100 chars, default 'operator'. */
  actor?: string;
}
