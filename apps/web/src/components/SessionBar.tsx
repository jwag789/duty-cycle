import { useEffect, useState, type CSSProperties } from 'react';
import type { RoomSnapshot } from '@duty-cycle/client';
import type { Peer } from '@duty-cycle/protocol';
import { Button } from './Button';

interface SessionBarProps {
  room: string | null;
  snapshot: RoomSnapshot;
  shareUrl: string | null;
  onStartJam: () => void;
  onLeave: () => void;
}

const STATUS_LABEL: Record<RoomSnapshot['status'], string> = {
  connecting: 'Joining…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  full: 'Room is full',
  failed: "Couldn't join",
};

export function SessionBar({ room, snapshot, shareUrl, onStartJam, onLeave }: SessionBarProps) {
  if (!room) {
    return (
      <div className="session-bar">
        <span className="session-mode">Solo</span>
        <span className="session-hint">Your song is saved in this browser.</span>
        <Button className="session-cta" onClick={onStartJam}>
          Start a jam →
        </Button>
      </div>
    );
  }

  const { status, me, peers } = snapshot;
  return (
    <div className="session-bar" data-status={status}>
      <span className="session-status" role="status">
        <span className="status-dot" aria-hidden="true" />
        {STATUS_LABEL[status]}
      </span>
      <span className="session-room">
        Room <code>{room}</code>
      </span>
      <ul className="peer-list" aria-label="Players in this room">
        {me && <PeerChip peer={me} you />}
        {peers.map((peer) => (
          <PeerChip key={peer.id} peer={peer} />
        ))}
      </ul>
      <div className="session-actions">
        {shareUrl && <CopyLink url={shareUrl} />}
        <Button onClick={onLeave}>Leave</Button>
      </div>
    </div>
  );
}

function PeerChip({ peer, you = false }: { peer: Peer; you?: boolean }) {
  return (
    <li className="peer-chip" style={{ '--peer': peer.color } as CSSProperties}>
      <span className="peer-swatch" aria-hidden="true" />
      {peer.name}
      {you && <span className="peer-you">you</span>}
    </li>
  );
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard blocked (insecure origin or denied): let them copy by hand.
      window.prompt('Copy this link to invite someone:', url);
    }
  };

  return (
    <Button className="session-cta" onClick={() => void copy()}>
      {copied ? 'Copied ✓' : 'Copy invite link'}
    </Button>
  );
}
