import type { FeedStatus } from '../hooks/useLiveTransport';

const TEXT: Record<FeedStatus, { label: string; title: string }> = {
  connecting: { label: 'connecting', title: 'Opening the live stream.' },
  live: { label: 'live', title: 'Receiving events over a live Server-Sent Events stream.' },
  polling: { label: 'polling', title: 'The live stream is unavailable; checking for new events about once a second.' },
  offline: { label: 'offline', title: 'The API cannot be reached. Showing the last data received.' },
};

export function FeedIndicator({ status }: { status: FeedStatus }) {
  return (
    <span className={`feed-ind feed-${status}`} title={TEXT[status].title}>
      <i aria-hidden="true" />
      {TEXT[status].label}
    </span>
  );
}
