import { useCallback, useEffect, useRef, useState } from 'react';
import type { SecurityEvent } from '@credential-reaper/shared';
import { fetchSecurityEvents, openEventStream } from '../api/client';
import { useLiveTransport, type FeedStatus } from './useLiveTransport';

const KEEP = 300;

export interface SecurityActivityState {
  /** Newest first, de-duplicated by id. */
  events: SecurityEvent[];
  load: 'loading' | 'ready' | 'error';
  error: string | null;
  transport: FeedStatus;
  reload: () => void;
}

/**
 * Recent events come from `GET /api/security-events` (the stream only follows live), then the SSE
 * stream resumes after the newest sequence number; polling the same route is the fallback.
 */
export function useSecurityActivity(limit: number): SecurityActivityState {
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const maxSeq = useRef(0);

  const merge = useCallback((incoming: SecurityEvent[]) => {
    setEvents((prev) => {
      const seen = new Set(prev.map((e) => e.id));
      const fresh = incoming.filter((e) => !seen.has(e.id));
      if (fresh.length === 0) return prev;
      const next = [...fresh, ...prev].sort((a, b) => b.seq - a.seq).slice(0, KEEP);
      maxSeq.current = Math.max(maxSeq.current, next[0]!.seq);
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSecurityEvents(limit).then(
      (list) => {
        if (cancelled) return;
        merge(list);
        setLoad('ready');
        setError(null);
      },
      (e: Error) => {
        if (cancelled) return;
        setError(e.message);
        setLoad('error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [limit, attempt, merge]);

  const transport = useLiveTransport({
    enabled: load === 'ready',
    pollMs: 3000,
    open: (cb) => openEventStream({ secAfter: maxSeq.current }, { ...cb, onSecurityEvent: (e) => merge([e]) }),
    poll: async () => merge(await fetchSecurityEvents(limit)),
  });

  const reload = useCallback(() => {
    setLoad('loading');
    setAttempt((n) => n + 1);
  }, []);

  return { events, load, error, transport: load === 'error' ? 'offline' : transport, reload };
}
