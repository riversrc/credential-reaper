import { useEffect, useRef, useState } from 'react';

/** live = Server-Sent Events open; polling = SSE unavailable, polling instead; offline = polling fails too. */
export type FeedStatus = 'connecting' | 'live' | 'polling' | 'offline';

interface TransportCallbacks {
  onOpen: () => void;
  onReconnect: () => void;
  onError: () => void;
}

interface Options {
  enabled: boolean;
  /** Opens the stream; wire the transport callbacks into `openEventStream`. Returns a close function. */
  open: (transport: TransportCallbacks) => () => void;
  /** One polling round. Must throw when the request fails. */
  poll: () => Promise<void>;
  pollMs: number;
}

/**
 * Prefers SSE and falls back to polling when the stream cannot be established. The server closes
 * every stream after ~30s on purpose (`reconnect` event); that is not treated as a failure.
 */
export function useLiveTransport({ enabled, open, poll, pollMs }: Options): FeedStatus {
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const openRef = useRef(open);
  const pollRef = useRef(poll);
  useEffect(() => {
    openRef.current = open;
    pollRef.current = poll;
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let closeStream: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let errors = 0;
    let expectClose = false;
    let pollFailures = 0;

    const startPolling = () => {
      closeStream?.();
      closeStream = null;
      setStatus('polling');
      const tick = async () => {
        try {
          await pollRef.current();
          pollFailures = 0;
          if (!cancelled) setStatus('polling');
        } catch {
          pollFailures++;
          if (!cancelled && pollFailures >= 2) setStatus('offline');
        }
        if (!cancelled) timer = setTimeout(tick, pollMs);
      };
      void tick();
    };

    if (typeof EventSource === 'undefined') {
      startPolling();
    } else {
      setStatus('connecting');
      closeStream = openRef.current({
        onOpen: () => {
          errors = 0;
          expectClose = false;
          setStatus('live');
        },
        onReconnect: () => {
          expectClose = true;
        },
        onError: () => {
          if (expectClose) {
            expectClose = false;
            return;
          }
          errors++;
          if (errors >= 2) startPolling();
          else setStatus('connecting');
        },
      });
    }

    return () => {
      cancelled = true;
      closeStream?.();
      clearTimeout(timer);
    };
  }, [enabled, pollMs]);

  return status;
}
