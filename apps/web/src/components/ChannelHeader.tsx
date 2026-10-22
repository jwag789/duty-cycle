import { CHANNELS, DUTY_CYCLES, MAX_DECAY, type ChannelSettings } from '@duty-cycle/protocol';
import { Button } from './Button';

interface ChannelHeaderProps {
  channel: number;
  settings: ChannelSettings;
  muted: boolean;
  onMute: () => void;
  onChange: (settings: Partial<ChannelSettings>) => void;
}

export function ChannelHeader({ channel, settings, muted, onMute, onChange }: ChannelHeaderProps) {
  const { name, kind } = CHANNELS[channel]!;

  return (
    <div className={muted ? 'channel-header is-muted' : 'channel-header'} data-channel={channel}>
      <div className="channel-title">
        <span className="channel-name">{name}</span>
        <Button className="mute" aria-pressed={muted} onClick={onMute} title={muted ? 'Unmute' : 'Mute'}>
          {muted ? 'Muted' : 'Mute'}
        </Button>
      </div>

      {kind === 'pulse' && (
        <div className="segmented" role="group" aria-label={`${name} duty cycle`}>
          {DUTY_CYCLES.map((duty, index) => (
            <Button key={duty} aria-pressed={settings.duty === index} onClick={() => onChange({ duty: index })}>
              {duty * 100}%
            </Button>
          ))}
        </div>
      )}
      {kind === 'noise' && (
        <div className="segmented" role="group" aria-label="Noise mode">
          <Button aria-pressed={!settings.shortNoise} onClick={() => onChange({ shortNoise: false })}>
            Hiss
          </Button>
          <Button aria-pressed={settings.shortNoise} onClick={() => onChange({ shortNoise: true })}>
            Metal
          </Button>
        </div>
      )}
      {kind === 'triangle' && <div className="channel-note">Fixed 4-bit wave</div>}

      <label className="decay">
        <span className="field-label">Decay</span>
        <input
          type="range"
          min={0}
          max={MAX_DECAY}
          value={settings.decay}
          onChange={(event) => onChange({ decay: Number(event.target.value) })}
          // Hand the keyboard back to the tracker once the slider is let go.
          onPointerUp={(event) => event.currentTarget.blur()}
          aria-label={`${name} decay`}
        />
        <output className="decay-value">{settings.decay === 0 ? 'hold' : settings.decay}</output>
      </label>
    </div>
  );
}
