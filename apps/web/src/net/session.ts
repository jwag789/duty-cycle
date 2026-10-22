import { MAX_NAME_LENGTH, ROOM_ID_PATTERN } from '@duty-cycle/protocol';

const ROOM_PATH = /^\/r\/([^/]+)\/?$/;
// No 0/o or 1/l, so a room code read aloud survives.
const ROOM_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const NAME_KEY = 'duty-cycle:name';

export function roomFromPath(pathname: string): string | null {
  const id = ROOM_PATH.exec(pathname)?.[1];
  return id && ROOM_ID_PATTERN.test(id) ? id : null;
}

export function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
}

export function roomUrl(room: string): string {
  return `${location.origin}/r/${room}`;
}

/** Same origin as the page; the Vite dev server proxies /ws to the room server. */
export function socketUrl(): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

const ADJECTIVES = ['Square', 'Pulse', 'Noisy', 'Lo-fi', 'Tiny', 'Bitty', 'Arp', 'Chip', 'Fuzzy', 'Neon', 'Retro', 'Sync'];
const ANIMALS = ['Fox', 'Owl', 'Moth', 'Crab', 'Yak', 'Newt', 'Lynx', 'Wren', 'Toad', 'Koi', 'Mole', 'Bat'];

/**
 * A made-up name, so nobody has to sign up to jam. Kept per tab (it survives a
 * refresh), so two tabs side by side show up as two different players.
 */
export function playerName(): string {
  try {
    const saved = sessionStorage.getItem(NAME_KEY);
    if (saved) return saved.slice(0, MAX_NAME_LENGTH);
  } catch {
    // Storage blocked: a fresh name each visit is fine.
  }
  const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)]!;
  const name = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
  try {
    sessionStorage.setItem(NAME_KEY, name);
  } catch {
    // As above.
  }
  return name;
}
