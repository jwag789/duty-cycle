import { useEffect, useRef, useState } from 'react';
import type { ChipEngine, EngineStats } from '@duty-cycle/engine';
import type { ClockStatus } from '@duty-cycle/client';
import { rowAt, type Transport } from '@duty-cycle/protocol';

interface SyncPanelProps {
  engine: ChipEngine | null;
  inRoom: boolean;
  clock: ClockStatus | null;
  transport: Transport;
  /** Reference clock minus performance.now(). */
  offset: number;
  onClose: () => void;
}

/** The numbers behind "everyone hears the same beat". Toggled with the ` key. */
export function SyncPanel({ engine, inRoom, clock, transport, offset, onClose }: SyncPanelProps) {
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [now, setNow] = useState(() => performance.now());
  // The first offset seen in this room, so the panel can show how far it has moved since.
  const firstOffset = useRef<number | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      setStats(engine?.stats() ?? null);
      setNow(performance.now());
    }, 250);
    return () => clearInterval(timer);
  }, [engine]);

  useEffect(() => {
    if (!clock) firstOffset.current = null;
    else if (firstOffset.current === null) firstOffset.current = clock.offset;
  }, [clock]);

  const position = transport.playing ? rowAt(transport, now + offset) : null;
  const drift = clock && firstOffset.current !== null ? clock.offset - firstOffset.current : null;

  return (
    <aside className="sync-panel" aria-label="Sync stats">
      <header>
        <span>Sync</span>
        <button type="button" className="sync-close" onClick={onClose} aria-label="Close sync stats">
          ×
        </button>
      </header>
      <dl>
        <Stat label="Clock" value={inRoom ? (clock ? `server, ${clock.samples} samples` : 'syncing…') : 'local (solo)'} />
        {inRoom && clock && (
          <>
            <Stat label="Round trip" value={`${ms(clock.rtt)} best · ${clock.lastRtt === null ? '—' : ms(clock.lastRtt)} last`} />
            <Stat label="Clock error" value={`≤ ${ms(clock.rtt / 2)}`} hint="Worst case for the best sample: half its round trip." />
            <Stat label="Offset drift" value={drift === null ? '—' : signed(drift)} hint="How far the clock estimate has moved since joining." />
          </>
        )}
        <Stat label="Audio latency" value={stats ? ms(stats.outputLatencyMs) : '—'} hint="Already accounted for: rows are scheduled to be heard on time." />
        <Stat
          label="Schedule error"
          value={stats?.scheduleErrorMs == null ? '—' : ms(stats.scheduleErrorMs)}
          hint="How closely the audio thread hit the row times it was given. Same-machine check only; Clock error is what separates players."
        />
        <Stat
          label="Transport"
          value={
            transport.playing
              ? `${transport.bpm} bpm · row ${position !== null && position >= transport.anchorRow ? Math.floor(position) : `starts in ${ms(transport.anchorTime - (now + offset))}`}`
              : `stopped · ${transport.bpm} bpm`
          }
        />
      </dl>
    </aside>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="sync-stat" title={hint}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ms(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : '−'}${ms(Math.abs(value))}`;
}
