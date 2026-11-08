// Server-Sent Events relay. The browser never talks to SpacetimeDB: this tails the two event
// tables by `seq` cursor with plain SQL polling (SpacetimeDB SQL allows one statement per
// request) and forwards new rows. Each connection is deliberately short-lived; EventSource
// reconnects with Last-Event-ID and resumes with no gaps and no duplicates.
import type { InvestigationEvent, SecurityEvent } from '@credential-reaper/shared';
import type { SpacetimeEnv } from './spacetime/client.js';
import { fetchInvestigationEvents, fetchMaxSeq, fetchSecurityEventsAfter } from './spacetime/repository.js';

/** About one poll per second per open stream. */
export const STREAM_POLL_INTERVAL_MS = 1000;
/** Workers cap subrequests per invocation (50 on the free plan); stay below it, leaving room for the seed check. */
export const STREAM_MAX_SPACETIME_CALLS = 40;
/** Hard bound on one connection so a forgotten tab cannot hold an isolate open indefinitely. */
export const STREAM_MAX_LIFETIME_MS = 30_000;
/** Keeps proxies and the browser from treating a quiet stream as dead. */
export const STREAM_HEARTBEAT_MS = 10_000;
/** Tells EventSource how long to wait before reconnecting after we close. */
export const STREAM_RETRY_MS = 1000;

export interface StreamParams {
  /** When set, only that investigation's progress events are streamed (security events are not). */
  investigationId: string | null;
  invAfter: number | null;
  secAfter: number | null;
}

/** Composite SSE id: `<investigationEventSeq>.<securityEventSeq>`. */
export function parseEventId(value: string | null): { inv: number; sec: number } | null {
  const m = value?.match(/^(\d{1,15})\.(\d{1,15})$/);
  return m ? { inv: Number(m[1]), sec: Number(m[2]) } : null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

export function openEventStream(env: SpacetimeEnv, request: Request, params: StreamParams, corsHeaders: Record<string, string>): Response {
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  const tailSecurity = params.investigationId === null;
  let calls = 0;
  let initialized = false;
  let closed = false;
  let lastSent = Date.now();
  let invCursor = params.invAfter ?? 0;
  let secCursor = params.secAfter ?? 0;
  const callsPerTick = tailSecurity ? 2 : 1;

  const frame = (event: string | null, data: string | null, id: boolean): string =>
    `${id ? `id: ${invCursor}.${secCursor}\n` : ''}${event ? `event: ${event}\n` : ''}${data !== null ? `data: ${data}\n` : ''}\n`;

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let sentThisPull = false;
        const send = (text: string) => {
          controller.enqueue(encoder.encode(text));
          lastSent = Date.now();
          sentThisPull = true;
        };
        const finish = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // already cancelled by the client
          }
        };
        const reconnect = () => {
          send(frame('reconnect', '{}', true));
          finish();
        };

        // A pull that enqueues nothing is never called again, so keep ticking until something is sent or we close.
        async function tick(): Promise<void> {
          if (!initialized) {
            initialized = true;
            send(`retry: ${STREAM_RETRY_MS}\n\n`);
            // No cursor supplied: follow live from "now" instead of replaying history (use the GET routes to backfill).
            if (params.invAfter === null && params.investigationId === null) {
              invCursor = await fetchMaxSeq(env, 'investigation_event');
              calls++;
            }
            if (params.secAfter === null && tailSecurity) {
              secCursor = await fetchMaxSeq(env, 'security_event');
              calls++;
            }
            send(frame(null, null, true));
          } else {
            await sleep(STREAM_POLL_INTERVAL_MS, request.signal);
          }

          if (closed) return;
          if (request.signal.aborted) return finish();
          if (Date.now() - startedAt >= STREAM_MAX_LIFETIME_MS || calls + callsPerTick > STREAM_MAX_SPACETIME_CALLS) return reconnect();

          calls += callsPerTick;
          const [invEvents, secEvents] = await Promise.all([
            fetchInvestigationEvents(env, params.investigationId, invCursor),
            tailSecurity ? fetchSecurityEventsAfter(env, null, secCursor) : Promise.resolve([] as SecurityEvent[]),
          ]);
          if (request.signal.aborted) return finish();

          for (const e of invEvents as InvestigationEvent[]) {
            invCursor = e.seq;
            send(frame('investigation-event', JSON.stringify(e), true));
          }
          for (const e of secEvents) {
            secCursor = e.seq;
            send(frame('security-event', JSON.stringify(e), true));
          }
          if (Date.now() - lastSent >= STREAM_HEARTBEAT_MS) send(': ping\n\n');
        }

        try {
          while (!closed && !sentThisPull) await tick();
        } catch {
          // Log nothing from the error itself beyond its kind: upstream text must not leak into logs or the stream.
          console.log(JSON.stringify({ event: 'stream_poll_failed', investigationId: params.investigationId }));
          try {
            if (!closed) reconnect();
          } catch {
            finish();
          }
        }
      },
      cancel() {
        closed = true;
      },
    },
    { highWaterMark: 0 }
  );

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      ...corsHeaders,
    },
  });
}
