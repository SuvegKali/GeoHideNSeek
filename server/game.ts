import { SCORING } from '../config/scoring.js';
import {
  getRoom,
  normalizeCode,
  pickSeeker,
  toClientRoom,
  RoomError,
  type Room,
} from './rooms.js';
import { scoreGuess, type Tier } from './scoring.js';

export type { Phase } from './rooms.js';

/** Overtime granted when a hider fails to lock before the freeze (mirrors client). */
export const HIDER_OVERTIME_SEC = 10;

export interface RoundEvents {
  broadcast(code: string, event: string, payload: unknown): void;
}

export interface RoundGuessResult {
  seekerId: string;
  targetHiderId: string;
  targetName: string;
  distanceKm: number;
  points: number;
  tier: Tier;
}

export interface RoundResults {
  reason: string;
  roundNo: number;
  guesses: RoundGuessResult[];
  survival: Array<{ playerId: string; name: string; points: number }>;
  totals: Array<{ playerId: string; name: string; score: number }>;
}

function emitState(room: Room, ev: RoundEvents): void {
  ev.broadcast(room.code, 'room:state', { room: toClientRoom(room) });
}

function checkModeSize(room: Room): void {
  const n = room.players.size;
  if (room.settings.mode === '1V1') {
    if (n !== 2) throw new RoomError('NEED_PLAYERS', '1v1 needs exactly 2 players to start');
  } else if (room.settings.mode === 'CLASSIC') {
    if (n < 3) throw new RoomError('NEED_PLAYERS', 'Classic needs at least 3 players (1 seeker + 2 hiders)');
  } else {
    const teams = new Set(
      [...room.players.values()].map((p) => (p.team ?? '').trim()).filter(Boolean),
    );
    if (n < 2 || teams.size < 2) {
      throw new RoomError('NEED_TEAMS', 'Teams mode needs at least 2 assigned teams to start');
    }
  }
}

/**
 * Owner starts a round: LOBBY/RESULTS → HIDING. Clears last round's
 * hides/guesses, ensures a connected seeker (auto random pick), and
 * emits `hiding:started` with the freeze deadline.
 */
export function startRound(
  code: string,
  requesterId: string | undefined,
  ev: RoundEvents,
  nowMs: number = Date.now(),
): { room: Room; freezeInMs: number; hidingInMs: number } {
  const room = getRoom(code);
  if (!room) throw new RoomError('ROOM_NOT_FOUND', `Room ${normalizeCode(code)} not found`);
  if (!requesterId || requesterId !== room.ownerId) {
    throw new RoomError('NOT_OWNER', 'Only the room owner can start a round');
  }
  if (room.phase === 'HIDING' || room.phase === 'SEEKING') {
    throw new RoomError('ROUND_ACTIVE', `Round ${room.roundNo} is already running`);
  }
  checkModeSize(room);
  const seeker = room.settings.seekerId ? room.players.get(room.settings.seekerId) : undefined;
  if (!seeker || !seeker.connected) {
    pickSeeker(code, requesterId, { mode: 'random' });
  }
  room.hides.clear();
  room.guesses = [];
  room.roundNo += 1;
  room.phase = 'HIDING';
  const freezeAt = nowMs + room.settings.hidingTimeSec * 1000;
  room.hidingEndsAtMs = freezeAt + HIDER_OVERTIME_SEC * 1000;
  delete room.seekingEndsAtMs;
  ev.broadcast(room.code, 'hiding:started', {
    roomCode: room.code,
    roundNo: room.roundNo,
    deadlineMs: freezeAt,
    endsAtMs: room.hidingEndsAtMs,
  });
  emitState(room, ev);
  return { room, freezeInMs: room.settings.hidingTimeSec * 1000, hidingInMs: room.hidingEndsAtMs - nowMs };
}

/** Hiding clock (incl. overtime) elapsed → SEEKING. Returns null unless HIDING. */
export function onHidingEnded(
  code: string,
  ev: RoundEvents,
  nowMs: number = Date.now(),
): { room: Room; seekingInMs: number } | null {
  const room = getRoom(code);
  if (!room || room.phase !== 'HIDING') return null;
  room.phase = 'SEEKING';
  room.seekingEndsAtMs = nowMs + room.settings.seekingTimeSec * 1000;
  delete room.hidingEndsAtMs;
  ev.broadcast(room.code, 'seeking:started', {
    roomCode: room.code,
    roundNo: room.roundNo,
    deadlineMs: room.seekingEndsAtMs,
  });
  emitState(room, ev);
  return { room, seekingInMs: room.settings.seekingTimeSec * 1000 };
}

/** All connected hiders locked → cut hiding short. Null unless it transitions. */
export function maybeStartSeeking(
  code: string,
  ev: RoundEvents,
  nowMs: number = Date.now(),
): { room: Room; seekingInMs: number } | null {
  const room = getRoom(code);
  if (!room || room.phase !== 'HIDING') return null;
  const hiders = [...room.players.values()].filter((p) => p.connected && p.id !== room.settings.seekerId);
  if (hiders.length === 0) return null;
  if (!hiders.every((h) => room.hides.has(h.id))) return null;
  return onHidingEnded(code, ev, nowMs);
}

/** Every locked hide guessed → score immediately. Null unless it ends. */
export function maybeEndSeeking(
  code: string,
  ev: RoundEvents,
): { room: Room; results: RoundResults } | null {
  const room = getRoom(code);
  if (!room || room.phase !== 'SEEKING') return null;
  if (room.hides.size === 0) return null;
  const guessed = new Set(room.guesses.map((g) => g.targetHiderId));
  if (![...room.hides.keys()].every((id) => guessed.has(id))) return null;
  return endRound(code, ev, 'all-guessed');
}

/** Seeking clock elapsed → score the round as-is. Returns null unless SEEKING. */
export function onSeekingEnded(code: string, ev: RoundEvents, reason = 'timeout'): { room: Room; results: RoundResults } | null {
  const room = getRoom(code);
  if (!room || room.phase !== 'SEEKING') return null;
  return endRound(code, ev, reason);
}

/** FOUND bonus: extend the seeking clock. Returns null outside SEEKING. */
export function addBonusTime(
  code: string,
  ev: RoundEvents,
  nowMs: number = Date.now(),
): { room: Room; deadlineMs: number } | null {
  const room = getRoom(code);
  if (!room || room.phase !== 'SEEKING') return null;
  const bonusSec = room.settings.bonusTimeSec;
  if (!Number.isFinite(bonusSec) || bonusSec <= 0) return null;
  room.seekingEndsAtMs = (room.seekingEndsAtMs ?? nowMs) + bonusSec * 1000;
  ev.broadcast(room.code, 'seeking:time-updated', {
    roomCode: room.code,
    roundNo: room.roundNo,
    deadlineMs: room.seekingEndsAtMs,
    bonusSec,
  });
  emitState(room, ev);
  return { room, deadlineMs: room.seekingEndsAtMs };
}

/**
 * Score the round as-is: guess points stand, unfound hiders (locked hide,
 * no FOUND guess) earn survival points. Room persists for the next round.
 */
export function endRound(code: string, ev: RoundEvents, reason: string): { room: Room; results: RoundResults } {
  const room = getRoom(code);
  if (!room) throw new RoomError('ROOM_NOT_FOUND', `Room ${normalizeCode(code)} not found`);
  if (room.phase !== 'HIDING' && room.phase !== 'SEEKING') {
    throw new RoomError('NO_ACTIVE_ROUND', 'There is no active round to end');
  }
  const mapScale = room.settings.mapScale;
  const foundTargets = new Set<string>();
  const guesses: RoundGuessResult[] = room.guesses.map((g) => {
    const target = room.players.get(g.targetHiderId);
    const tier = scoreGuess(g.distanceKm, mapScale).tier;
    if (tier === 'FOUND') foundTargets.add(g.targetHiderId);
    return {
      seekerId: g.seekerId,
      targetHiderId: g.targetHiderId,
      targetName: target?.name ?? 'unknown',
      distanceKm: g.distanceKm,
      points: g.points,
      tier,
    };
  });
  const survival: RoundResults['survival'] = [];
  for (const playerId of room.hides.keys()) {
    if (foundTargets.has(playerId)) continue;
    const player = room.players.get(playerId);
    if (!player) continue;
    const pts = SCORING[mapScale].hiderSurvivalPts;
    player.score += pts;
    survival.push({ playerId, name: player.name, points: pts });
  }
  const seekerTotals = new Map<string, number>();
  for (const g of room.guesses) {
    seekerTotals.set(g.seekerId, (seekerTotals.get(g.seekerId) ?? 0) + g.points);
  }
  for (const [seekerId, pts] of seekerTotals) {
    const seeker = room.players.get(seekerId);
    if (seeker) seeker.score += pts;
  }
  room.phase = 'RESULTS';
  delete room.hidingEndsAtMs;
  delete room.seekingEndsAtMs;
  const results: RoundResults = {
    reason,
    roundNo: room.roundNo,
    guesses,
    survival,
    totals: [...room.players.values()]
      .map((p) => ({ playerId: p.id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score),
  };
  ev.broadcast(room.code, 'round:ended', {
    roomCode: room.code,
    roundNo: room.roundNo,
    reason,
    results,
    room: toClientRoom(room),
  });
  return { room, results };
}
