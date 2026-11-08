import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InvestigationEvent } from '@credential-reaper/shared';
import { fetchInvestigationEvents, openEventStream } from '../api/client';
import { deriveActivity, isTerminalPhase, type ActivityOutcome, type ActivityView } from '../lib/investigationActivity';
import { useLiveTransport, type FeedStatus } from './useLiveTransport';

export interface InvestigationActivity {
  view: ActivityView;
  transport: FeedStatus;
  /** Local clock reading when watching began; the base for the live elapsed timer. */
  watchStartedMs: number;
}

/**
 * Follows one investigation's real progress events. `investigationId` must stay stable for the
 * hook's lifetime (remount with a `key` for a new run). Pass `outcome` once the start request
 * settles so the view can finish even if the feed missed the terminal event.
 */
export function useInvestigationActivity(investigationId: string, outcome: ActivityOutcome | null): InvestigationActivity {
  const [events, setEvents] = useState<InvestigationEvent[]>([]);
  const [watchStartedMs] = useState(() => Date.now());
  const maxSeq = useRef(0);

  const addEvents = useCallback((incoming: InvestigationEvent[]) => {
    setEvents((prev) => {
      const seen = new Set(prev.map((e) => e.seq));
      const fresh = incoming.filter((e) => e.investigationId === investigationId && !seen.has(e.seq));
      if (fresh.length === 0) return prev;
      const next = [...prev, ...fresh].sort((a, b) => a.seq - b.seq);
      maxSeq.current = next[next.length - 1]!.seq;
      return next;
    });
  }, [investigationId]);

  // The outcome only counts once the catch-up fetch below has run, so a fast finish never shows an empty tool list.
  const [caughtUp, setCaughtUp] = useState(false);
  const view = useMemo(() => deriveActivity(events, caughtUp ? outcome : null), [events, outcome, caughtUp]);
  const done = isTerminalPhase(view.phase);

  const transport = useLiveTransport({
    enabled: !done,
    pollMs: 1000,
    open: (cb) =>
      openEventStream({ investigationId, invAfter: maxSeq.current }, { ...cb, onInvestigationEvent: (e) => addEvents([e]) }),
    poll: async () => addEvents(await fetchInvestigationEvents(investigationId, maxSeq.current)),
  });

  // The start request returned: fetch whatever the feed has not delivered yet, once.
  useEffect(() => {
    if (!outcome) return;
    fetchInvestigationEvents(investigationId, maxSeq.current)
      .then(addEvents, () => undefined)
      .finally(() => setCaughtUp(true));
  }, [outcome, investigationId, addEvents]);

  return { view, transport, watchStartedMs };
}
