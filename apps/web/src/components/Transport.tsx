import { useEffect, useState } from 'react';
import { MAX_BPM, MIN_BPM } from '@duty-cycle/protocol';
import { MAX_OCTAVE, MAX_STEP, MIN_OCTAVE } from '../editor';
import { Button } from './Button';

interface TransportProps {
  playing: boolean;
  bpm: number;
  octave: number;
  step: number;
  onTogglePlay: () => void;
  onBpm: (bpm: number) => void;
  onOctave: (octave: number) => void;
  onStep: (step: number) => void;
}

export function Transport({ playing, bpm, octave, step, onTogglePlay, onBpm, onOctave, onStep }: TransportProps) {
  return (
    <div className="transport">
      <Button className={playing ? 'play is-playing' : 'play'} onClick={onTogglePlay} aria-pressed={playing}>
        <span aria-hidden="true">{playing ? '■' : '▶'}</span>
        {playing ? 'Stop' : 'Play'}
        <kbd>Space</kbd>
      </Button>
      <BpmField bpm={bpm} onBpm={onBpm} />
      <Stepper label="Octave" value={octave} min={MIN_OCTAVE} max={MAX_OCTAVE} onChange={onOctave} keys="[ ]" />
      <Stepper label="Step" value={step} min={0} max={MAX_STEP} onChange={onStep} keys="- =" />
    </div>
  );
}

function BpmField({ bpm, onBpm }: { bpm: number; onBpm: (bpm: number) => void }) {
  const [draft, setDraft] = useState(String(bpm));
  useEffect(() => setDraft(String(bpm)), [bpm]);

  const commit = () => {
    const value = Math.round(Number(draft));
    if (Number.isFinite(value)) onBpm(Math.min(MAX_BPM, Math.max(MIN_BPM, value)));
    else setDraft(String(bpm));
  };

  return (
    <label className="field">
      <span className="field-label">BPM</span>
      <input
        className="bpm-input"
        type="number"
        inputMode="numeric"
        min={MIN_BPM}
        max={MAX_BPM}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur();
        }}
      />
    </label>
  );
}

interface StepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  keys: string;
  onChange: (value: number) => void;
}

function Stepper({ label, value, min, max, keys, onChange }: StepperProps) {
  return (
    <div className="field" role="group" aria-label={label}>
      <span className="field-label">
        {label} <kbd>{keys}</kbd>
      </span>
      <div className="stepper">
        <Button aria-label={`${label} down`} disabled={value <= min} onClick={() => onChange(value - 1)}>
          −
        </Button>
        <output className="stepper-value">{value}</output>
        <Button aria-label={`${label} up`} disabled={value >= max} onClick={() => onChange(value + 1)}>
          +
        </Button>
      </div>
    </div>
  );
}
