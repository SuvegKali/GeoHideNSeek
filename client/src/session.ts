import type { Socket } from 'socket.io-client';
import type { ClientRoom, Player } from './types';

// Tab-scoped session. localStorage is shared across tabs, which breaks
// identity (owner/seeker checks) with 2+ windows open — sessionStorage
// keeps each tab playing as exactly one player.
const K_CODE = 'ghns:code';
const K_PID = 'ghns:playerId';
const K_NAME = 'ghns:name';

export interface StoredSession {
  code: string;
  playerId: string;
  name: string;
}

export interface SessionRestore {
  session: StoredSession | null;
  room?: ClientRoom;
  player?: Player;
  restored: boolean;
}

export function loadSession(): StoredSession | null {
  try {
    const code = sessionStorage.getItem(K_CODE);
    const playerId = sessionStorage.getItem(K_PID);
    if (!code || !playerId) return null;
    return { code, playerId, name: sessionStorage.getItem(K_NAME) ?? '' };
  } catch {
    return null;
  }
}

export function saveSession(code: string, playerId: string, name: string): void {
  try {
    sessionStorage.setItem(K_CODE, code);
    sessionStorage.setItem(K_PID, playerId);
    sessionStorage.setItem(K_NAME, name);
  } catch {
    // Storage blocked — session simply won't survive reloads.
  }
}

function emitAck<T>(socket: Socket, ev: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => {
    socket.emit(ev, payload, (res: T) => resolve(res));
  });
}

let pendingId: string | null = null;
let pending: Promise<SessionRestore> | null = null;

/**
 * Rebind a fresh socket to this tab's stored seat (page reload /
 * reconnect). Single-flight per socket id so all mounted views share it.
 */
export function ensureSession(socket: Socket): Promise<SessionRestore> {
  const id = socket.id ?? null;
  if (pending && pendingId === id) return pending;
  pendingId = id;
  pending = (async (): Promise<SessionRestore> => {
    const stored = loadSession();
    if (!stored || !stored.name) return { session: stored, restored: false };
    const res = await emitAck<{
      ok: boolean;
      room?: ClientRoom;
      player?: Player;
    }>(socket, 'rejoin', { code: stored.code, name: stored.name });
    if (res?.ok && res.room && res.player) {
      saveSession(res.room.code, res.player.id, res.player.name);
      return { session: loadSession(), room: res.room, player: res.player, restored: true };
    }
    return { session: stored, restored: false };
  })();
  return pending;
}
