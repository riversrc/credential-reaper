import { useEffect } from 'react';
import { DAY_MS, totalDays } from '../../lib/networkGraph';
import { useReducedMotion } from '../../hooks/useReducedMotion';

interface TimeScrubberProps {
  startMs: number;
  nowMs: number;
  day: number;
  onDayChange: (day: number) => void;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  createdMarks: { id: string; name: string; ms: number }[];
  locked: boolean;
}

export function TimeScrubber({ startMs, nowMs, day, onDayChange, playing, onPlayingChange, createdMarks, locked }: TimeScrubberProps) {
  const reduced = useReducedMotion();
  const max = totalDays(startMs, nowMs);
  const atPresent = day >= max;
  const at = atPresent ? nowMs : startMs + day * DAY_MS;

  useEffect(() => {
    if (!playing) return;
    const step = Math.max(1, Math.ceil(max / 140));
    const timer = window.setInterval(() => {
      onDayChange(Math.min(max, day + step));
    }, 55);
    return () => window.clearInterval(timer);
  }, [playing, day, max, onDayChange]);

  useEffect(() => {
    if (playing && day >= max) onPlayingChange(false);
  }, [playing, day, max, onPlayingChange]);

  const label = new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const span = Math.max(1, nowMs - startMs);

  return (
    <div className="scrubber">
      <div className="scrubber-readout">
        <span className="scrubber-date" aria-live="off">
          {label}
        </span>
        <span className="muted-sm">{atPresent ? 'NOW' : 'HISTORY · derived from usage'}</span>
      </div>
      <div className="scrubber-row">
        {!reduced && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={locked || max === 0}
            aria-pressed={playing}
            onClick={() => {
              if (!playing && atPresent) onDayChange(0);
              onPlayingChange(!playing);
            }}
          >
            {playing ? 'Pause' : 'Play'}
          </button>
        )}
        <div className="scrubber-track">
          <div className="scrubber-marks" aria-hidden="true">
            {createdMarks
              .filter((m) => m.ms >= startMs && m.ms <= nowMs)
              .map((m) => (
                <span key={m.id} className="scrubber-mark" style={{ left: `${((m.ms - startMs) / span) * 100}%` }} title={`${m.name} created`} />
              ))}
          </div>
          <input
            type="range"
            min={0}
            max={max}
            step={1}
            value={Math.min(day, max)}
            disabled={locked || max === 0}
            aria-label="Map time"
            aria-valuetext={label}
            onChange={(e) => {
              onPlayingChange(false);
              onDayChange(Number(e.target.value));
            }}
          />
        </div>
        <button type="button" className="btn btn-secondary btn-sm" disabled={atPresent} onClick={() => { onPlayingChange(false); onDayChange(max); }}>
          Now
        </button>
      </div>
    </div>
  );
}
