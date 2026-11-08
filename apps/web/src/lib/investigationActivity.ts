import type { InvestigationEvent, InvestigationEventStatus, InvestigationStage } from '@credential-reaper/shared';

/**
 * `executing-tools` means a tool call is running right now. Everything is derived from real events
 * (plus the final HTTP outcome); nothing here predicts, estimates or invents progress.
 */
export type ActivityPhase = 'waiting' | 'gathering' | 'executing-tools' | 'analyzing' | 'completing' | 'failed' | 'completed';

export const STAGES: InvestigationStage[] = ['waiting', 'gathering', 'analyzing', 'completing'];

export type ActivityOutcome = { status: 'completed' } | { status: 'failed'; message: string; interrupted: boolean };

export interface ToolActivity {
  key: string;
  /** Position of the call in the run, parsed from the event's own counter text. */
  callNumber: number | null;
  tool: string | null;
  message: string;
  status: InvestigationEventStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  /** Full `details` of each event for this call, shown in an expandable. */
  details: string[];
}

export interface ActivityView {
  phase: ActivityPhase;
  /** Last stage reported by an event, or `waiting` before any event. */
  stage: InvestigationStage;
  tools: ToolActivity[];
  /** Highest call number seen in the events, and the maximum the events advertised (null if never stated). */
  callsSeen: number;
  callLimit: number | null;
  findings: number;
  /** Timestamp of the `investigation-started` event. */
  startedAt: string | null;
  /** Timestamp of the terminal event. */
  endedAt: string | null;
  latestMessage: string | null;
  failureMessage: string | null;
  /** The run ended by losing the connection, not by a reported failure: it may still be running server-side. */
  interrupted: boolean;
  events: InvestigationEvent[];
}

const COUNTER = /Tool call (\d+)(?: of at most (\d+))?/;
const DURATION = /(\d+) ms\./;

export function deriveActivity(events: InvestigationEvent[], outcome: ActivityOutcome | null): ActivityView {
  const tools: ToolActivity[] = [];
  let callsSeen = 0;
  let callLimit: number | null = null;
  let findings = 0;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let sawCompleted = false;
  let sawFailed = false;
  let stage: InvestigationStage = 'waiting';

  for (const e of events) {
    stage = e.stage;
    const m = COUNTER.exec(e.details);
    const callNumber = m ? Number(m[1]) : null;
    if (m) {
      callsSeen = Math.max(callsSeen, Number(m[1]));
      if (m[2]) callLimit = Number(m[2]);
    }
    switch (e.eventType) {
      case 'investigation-started':
        startedAt = e.timestamp;
        break;
      case 'finding-recorded':
        findings++;
        break;
      case 'investigation-completed':
        sawCompleted = true;
        endedAt = e.timestamp;
        break;
      case 'investigation-failed':
        sawFailed = true;
        endedAt = e.timestamp;
        break;
      case 'tool-started':
        tools.push({
          key: callNumber !== null ? `call-${callNumber}` : `seq-${e.seq}`,
          callNumber,
          tool: e.toolName,
          message: e.message,
          status: 'running',
          startedAt: e.timestamp,
          endedAt: null,
          durationMs: null,
          details: [e.details],
        });
        break;
      case 'tool-completed': {
        let entry = tools.find((t) => t.status === 'running' && (callNumber !== null ? t.callNumber === callNumber : t.tool === e.toolName));
        if (!entry) {
          entry = { key: callNumber !== null ? `call-${callNumber}` : `seq-${e.seq}`, callNumber, tool: e.toolName, message: e.message, status: 'running', startedAt: e.timestamp, endedAt: null, durationMs: null, details: [] };
          tools.push(entry);
        }
        const d = DURATION.exec(e.details);
        entry.status = e.status === 'running' ? 'completed' : e.status;
        entry.message = e.message;
        entry.endedAt = e.timestamp;
        entry.durationMs = d ? Number(d[1]) : Math.max(0, Date.parse(e.timestamp) - Date.parse(entry.startedAt));
        entry.details.push(e.details);
        break;
      }
      default:
        break;
    }
  }

  const failed = sawFailed || outcome?.status === 'failed';
  const completed = !failed && (sawCompleted || outcome?.status === 'completed');
  const anyRunning = tools.some((t) => t.status === 'running');

  let phase: ActivityPhase;
  if (failed) phase = 'failed';
  else if (completed) phase = 'completed';
  else if (anyRunning) phase = 'executing-tools';
  else phase = stage;

  const failedOutcome = outcome?.status === 'failed' ? outcome : null;
  return {
    phase,
    stage,
    tools,
    callsSeen,
    callLimit,
    findings,
    startedAt,
    endedAt,
    latestMessage: events.length ? events[events.length - 1]!.message : null,
    failureMessage: failedOutcome?.message ?? null,
    interrupted: failedOutcome?.interrupted === true && !sawFailed,
    events,
  };
}

export function isTerminalPhase(phase: ActivityPhase): boolean {
  return phase === 'failed' || phase === 'completed';
}

export const PHASE_LABEL: Record<ActivityPhase, string> = {
  waiting: 'Waiting',
  gathering: 'Gathering evidence',
  'executing-tools': 'Running a tool',
  analyzing: 'Analyzing',
  completing: 'Completing',
  failed: 'Failed',
  completed: 'Completed',
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
}
