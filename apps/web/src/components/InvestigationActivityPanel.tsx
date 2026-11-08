import { useState } from 'react';
import type { InvestigationStage } from '@credential-reaper/shared';
import { useInvestigationActivity } from '../hooks/useInvestigationActivity';
import { useNow } from '../hooks/useNow';
import {
  PHASE_LABEL,
  STAGES,
  formatDuration,
  isTerminalPhase,
  type ActivityOutcome,
  type ActivityView,
  type ToolActivity,
} from '../lib/investigationActivity';
import { StatusBadge } from './Badges';
import { FeedIndicator } from './FeedIndicator';
import { StateMessage } from './StateMessage';
import '../activity.css';

const STAGE_LABEL: Record<InvestigationStage, string> = {
  waiting: 'Waiting',
  gathering: 'Gathering',
  analyzing: 'Analyzing',
  completing: 'Completing',
};

interface Props {
  investigationId: string;
  identityName: string;
  outcome: ActivityOutcome | null;
}

/** Remount with a new `key` for each run. */
export function InvestigationActivityPanel({ investigationId, identityName, outcome }: Props) {
  const { view, transport, watchStartedMs } = useInvestigationActivity(investigationId, outcome);
  const done = isTerminalPhase(view.phase);
  const now = useNow(!done);
  const [expanded, setExpanded] = useState(true);
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  if (view.phase === 'completed' && !autoCollapsed) {
    setAutoCollapsed(true);
    setExpanded(false);
  }

  const elapsedMs =
    done && view.startedAt && view.endedAt ? Date.parse(view.endedAt) - Date.parse(view.startedAt) : Math.max(0, now - watchStartedMs);
  const bodyId = `activity-body-${investigationId}`;
  const counter =
    view.callsSeen === 0 ? 'No tool calls yet' : view.callLimit ? `Tool call ${view.callsSeen} of at most ${view.callLimit}` : `Tool call ${view.callsSeen}`;

  return (
    <section className={`panel bracketed activity is-${view.phase}`} aria-label={`Agent activity for ${identityName}`}>
      <div className="activity-head">
        <h3>Agent activity</h3>
        <span className="activity-id muted-sm">{identityName}</span>
        {!done && <FeedIndicator status={transport} />}
        <button type="button" className="btn btn-secondary btn-sm" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Collapse' : 'Details'}
        </button>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {PHASE_LABEL[view.phase]}
        {view.phase === 'failed' && view.failureMessage ? `: ${view.failureMessage}` : ''}
      </p>

      <dl className="activity-stats">
        <div>
          <dt>State</dt>
          <dd className={`activity-phase phase-${view.phase}`}>
            {!done && <span className="cursor" aria-hidden="true" />}
            {PHASE_LABEL[view.phase]}
          </dd>
        </div>
        <div>
          <dt>{done ? 'Took' : 'Elapsed'}</dt>
          <dd>{formatDuration(elapsedMs)}</dd>
        </div>
        <div>
          <dt>Tool calls</dt>
          <dd>{view.callsSeen}</dd>
        </div>
        <div>
          <dt>Findings recorded</dt>
          <dd>{view.findings}</dd>
        </div>
      </dl>

      <div id={bodyId} hidden={!expanded}>
        <StageTrack view={view} />

        {view.phase === 'failed' && (
          <StateMessage kind="error">
            {view.interrupted
              ? `${view.failureMessage ?? 'Connection lost.'} The investigation may still be running on the server; check the list below.`
              : (view.failureMessage ?? 'The investigation failed. See the investigation record for the reason.')}
          </StateMessage>
        )}
        {!done && transport === 'offline' && (
          <StateMessage kind="error">Live progress is unavailable. The result will appear when the API responds.</StateMessage>
        )}

        {(!done || view.callsSeen > 0) && <p className="activity-counter muted-sm">
          {counter}
          {view.latestMessage && !done ? <> · latest: {view.latestMessage}</> : null}
        </p>}

        {view.tools.length === 0 ? (
          <p className="muted-sm activity-none">{done ? 'No tool calls were reported.' : 'No tool has started yet.'}</p>
        ) : (
          <ol className="activity-tools" aria-label="Tool calls">
            {view.tools.map((t) => (
              <ToolRow key={t.key} tool={t} />
            ))}
          </ol>
        )}

        {view.events.length > 0 && <EventLog view={view} />}
      </div>
    </section>
  );
}

function StageTrack({ view }: { view: ActivityView }) {
  const current = STAGES.indexOf(view.stage);
  return (
    <ol className="stage-track" aria-label="Stages">
      {STAGES.map((s, i) => {
        const state =
          view.phase === 'completed' ? 'done' : i < current ? 'done' : i === current ? (view.phase === 'failed' ? 'failed' : 'current') : 'todo';
        return (
          <li key={s} className={`stage stage-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="stage-mark" aria-hidden="true" />
            <span className="stage-name">{STAGE_LABEL[s]}</span>
            <span className="sr-only"> ({state === 'todo' ? 'not reached' : state})</span>
          </li>
        );
      })}
    </ol>
  );
}

function ToolRow({ tool }: { tool: ToolActivity }) {
  return (
    <li className="act-tool">
      <details className="disc">
        <summary className="disc-sum act-tool-sum">
          <span className="act-tool-n muted-sm">{tool.callNumber !== null ? `#${tool.callNumber}` : '·'}</span>
          <span className="act-tool-name">
            <code>{tool.tool ?? 'step'}</code>
            <span className="muted-sm">{tool.message}</span>
          </span>
          <StatusBadge status={tool.status} />
          <span className="act-tool-time muted-sm">{tool.durationMs !== null ? formatDuration(tool.durationMs) : '…'}</span>
        </summary>
        <div className="act-tool-body">
          {tool.details.filter(Boolean).map((d, i) => (
            <p key={i} className="mono">
              {d}
            </p>
          ))}
        </div>
      </details>
    </li>
  );
}

function EventLog({ view }: { view: ActivityView }) {
  const t0 = Date.parse(view.events[0]!.timestamp);
  return (
    <details className="disc activity-log">
      <summary className="disc-sum">
        <span className="muted-sm">Event log ({view.events.length})</span>
      </summary>
      <ol>
        {view.events.map((e) => (
          <li key={e.seq}>
            <span className="muted-sm" title={e.timestamp}>
              +{formatDuration(Math.max(0, Date.parse(e.timestamp) - t0))}
            </span>
            <span className="act-log-type">{e.eventType}</span>
            <span>{e.message}</span>
            {e.details && <span className="muted-sm act-log-details">{e.details}</span>}
          </li>
        ))}
      </ol>
    </details>
  );
}
