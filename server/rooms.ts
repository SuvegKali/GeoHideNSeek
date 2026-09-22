// Room store — tracks players, connection status, teams, scores.
// In-memory for v1. All state transitions are gated on the server.
//
// Spec: 6-char room code, no login, max 10 players/room.
// Hider disconnect → keep seat, allow rejoin next round with same code + name.
// Seeker disconnect → 30s grace (timer lives in index.ts), then round ends as-is.

import { randomBytes, randomUUID } from 'node:crypto';
import { haversineKm, scoreGuess, type Tier } from './scoring.js';

export interface RoomSettings {
  mapScale: 'WORLD' | 'CONTINENT' | 'COUNTRY' | 'CITY';
  regionId: string;
  hidingTimeSec: number;
  seekingTimeSec: number;
  bonusTimeSec: number;
  mode: 'CLASSIC' | '1V1' | 'TEAMS';
  seekerId?: string;
}

export interface Player {
  id: string;
  name: string;
  team?: string;
  connected: boolean;
  score: number;
}

export interface Hide {
  playerId: string;
  lat: number;
  lng: number;
  panoId: string;
}

export interface Guess {
  seekerId: string;
  targetHiderId: string;
  lat: number;
  lng: number;
  distanceKm: number;
  points: number;
}

export interface Room {
  code: string;
  settings: RoomSettings;
  players: Map<string, Player>;
  /** Locked hides by player id (panoId required — Street View only). */
  hides: Map<string, Hide>;
  /** Locked guesses (re-lock per hider overwrites). */
  guesses: Guess[];
  /** Round phase machine state (transitions live in game.ts). */
  phase: Phase;
  roundNo: number;
  /** Freeze+overtime end (hiding) and seeking end, ms epoch. */
  hidingEndsAtMs?: number;
  seekingEndsAtMs?: number;
  ownerId: string;
  createdAtMs: number;
}

export type Phase = 'LOBBY' | 'HIDING' | 'SEEKING' | 'RESULTS';

/** Serializable snapshot broadcast to clients. */
export interface ClientRoom {
  code: string;
  settings: RoomSettings;
  ownerId: string;
  players: Player[];
  playerCount: number;
  /** Count only — hide locations stay server-side until seeking. */
  hideCount: number;
  phase: Phase;
  roundNo: number;
  hidingEndsAtMs?: number;
  seekingEndsAtMs?: number;
}

export const MAX_PLAYERS = 10;
/** Seeker disconnect grace before the round ends scored as-is. */
export const SEEKER_GRACE_SEC = 30;
export const ROOM_CODE_LEN = 6;

/** Region presets with verified Street View coverage. Custom regions are rejected. */
export interface RegionPreset {
  id: string;
  label: string;
  scale: RoomSettings['mapScale'];
}

export const REGION_PRESETS: RegionPreset[] = [
  { id: 'world', label: 'World', scale: 'WORLD' },
  { id: 'europe', label: 'Europe', scale: 'CONTINENT' },
  { id: 'asia', label: 'Asia', scale: 'CONTINENT' },
  { id: 'north-america', label: 'North America', scale: 'CONTINENT' },
  { id: 'africa', label: 'Africa', scale: 'CONTINENT' },
  { id: 'united-states', label: 'United States', scale: 'COUNTRY' },
  { id: 'france', label: 'France', scale: 'COUNTRY' },
  { id: 'japan', label: 'Japan', scale: 'COUNTRY' },
  { id: 'brazil', label: 'Brazil', scale: 'COUNTRY' },
  { id: 'paris', label: 'Paris', scale: 'CITY' },
  { id: 'tokyo', label: 'Tokyo', scale: 'CITY' },
  { id: 'new-york', label: 'New York', scale: 'CITY' },
];

/** Mirror of this list lives in client/src/regions.ts — keep them in sync. */
export function isSupportedRegion(regionId: string, mapScale: RoomSettings['mapScale']): boolean {
  return REGION_PRESETS.some((p) => p.id === regionId && p.scale === mapScale);
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const rooms = new Map<string, Room>();

export class RoomError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function generateRoomCode(): string {
  const bytes = randomBytes(ROOM_CODE_LEN);
  let out = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

export function generateUniqueRoomCode(): string {
  for (let i = 0; i < 100; i++) {
    const code = generateRoomCode();
    if (!rooms.has(code)) return code;
  }
  throw new RoomError('CODE_COLLISION', 'Could not generate a unique room code');
}

const MAP_SCALES = new Set(['WORLD', 'CONTINENT', 'COUNTRY', 'CITY']);
const MODES = new Set(['CLASSIC', '1V1', 'TEAMS']);

export function validateSettings(s: RoomSettings): string | null {
  if (!s || typeof s !== 'object') return 'Settings are required';
  if (!MAP_SCALES.has(s.mapScale)) return 'Invalid mapScale (WORLD|CONTINENT|COUNTRY|CITY)';
  if (typeof s.regionId !== 'string' || !isSupportedRegion(s.regionId.trim(), s.mapScale)) {
    return 'Unsupported region (pick a preset with Street View coverage for this map scale)';
  }
  if (!Number.isFinite(s.hidingTimeSec) || s.hidingTimeSec <= 0 || s.hidingTimeSec > 3600) {
    return 'hidingTimeSec must be 1..3600';
  }
  if (!Number.isFinite(s.seekingTimeSec) || s.seekingTimeSec <= 0 || s.seekingTimeSec > 3600) {
    return 'seekingTimeSec must be 1..3600';
  }
  if (!Number.isFinite(s.bonusTimeSec) || s.bonusTimeSec < 0 || s.bonusTimeSec > 600) {
    return 'bonusTimeSec must be 0..600';
  }
  if (!MODES.has(s.mode)) return 'Invalid mode (CLASSIC|1V1|TEAMS)';
  if (s.seekerId !== undefined && typeof s.seekerId !== 'string') return 'seekerId must be a string';
  return null;
}

export function validateDisplayName(name: string): string | null {
  if (typeof name !== 'string') return 'Display name is required';
  const t = name.trim();
  if (t.length === 0) return 'Display name is required';
  if (t.length > 20) return 'Display name must be ≤20 chars';
  return null;
}

export function defaultSettings(): RoomSettings {
  return {
    mapScale: 'WORLD',
    regionId: 'world',
    hidingTimeSec: 60,
    seekingTimeSec: 300,
    bonusTimeSec: 30,
    mode: 'CLASSIC',
  };
}

export function createRoom(ownerName: string, settings: RoomSettings): { room: Room; player: Player } {
  const nameErr = validateDisplayName(ownerName);
  if (nameErr) throw new RoomError('INVALID_NAME', nameErr);
  const settingsErr = validateSettings(settings);
  if (settingsErr) throw new RoomError('INVALID_SETTINGS', settingsErr);

  const code = generateUniqueRoomCode();
  const player: Player = {
    id: randomUUID(),
    name: ownerName.trim(),
    connected: true,
    score: 0,
  };
  const room: Room = {
    code,
    settings: { ...settings },
    players: new Map([[player.id, player]]),
    hides: new Map(),
    guesses: [],
    phase: 'LOBBY',
    roundNo: 0,
    ownerId: player.id,
    createdAtMs: Date.now(),
  };
  rooms.set(code, room);
  return { room, player };
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(normalizeCode(code));
}

export function findPlayerByName(room: Room, name: string): Player | undefined {
  const t = name.trim().toLowerCase();
  for (const p of room.players.values()) {
    if (p.name.toLowerCase() === t) return p;
  }
  return undefined;
}

export function joinRoom(code: string, displayName: string): { room: Room; player: Player } {
  const room = getRoom(code);
  if (!room) throw new RoomError('ROOM_NOT_FOUND', `Room ${normalizeCode(code)} not found`);
  const nameErr = validateDisplayName(displayName);
  if (nameErr) throw new RoomError('INVALID_NAME', nameErr);

  const existing = findPlayerByName(room, displayName);
  if (existing) {
    if (!existing.connected) {
      throw new RoomError(
        'NAME_TAKEN_REJOIN_AVAILABLE',
        `"${existing.name}" is reserved for a disconnected player — use rejoin with the same code + name`,
      );
    }
    throw new RoomError('NAME_TAKEN', `"${existing.name}" is already in this room`);
  }
  if (room.players.size >= MAX_PLAYERS) {
    throw new RoomError('ROOM_FULL', `Room is full (max ${MAX_PLAYERS} players)`);
  }

  const player: Player = {
    id: randomUUID(),
    name: displayName.trim(),
    connected: true,
    score: 0,
  };
  room.players.set(player.id, player);
  return { room, player };
}

/** Rejoin keeps the same seat (id, team, score) and flips connected=true. */
export function rejoinRoom(code: string, displayName: string): { room: Room; player: Player } {
  const room = getRoom(code);
  if (!room) throw new RoomError('ROOM_NOT_FOUND', `Room ${normalizeCode(code)} not found`);
  const nameErr = validateDisplayName(displayName);
  if (nameErr) throw new RoomError('INVALID_NAME', nameErr);

  const existing = findPlayerByName(room, displayName);
  if (!existing) throw new RoomError('NOT_IN_ROOM', `"${displayName.trim()}" has no seat in room ${room.code}`);
  if (existing.connected) throw new RoomError('ALREADY_CONNECTED', `"${existing.name}" is already connected`);
  existing.connected = true;
  return { room, player: existing };
}

/** Mark a player disconnected but keep their seat. Returns true if they were the seeker. */
export function markDisconnected(room: Room, playerId: string): { player: Player; wasSeeker: boolean } {
  const player = room.players.get(playerId);
  if (!player) throw new RoomError('NOT_IN_ROOM', 'Player not in room');
  player.connected = false;
  return { player, wasSeeker: room.settings.seekerId === playerId };
}

export function isSeeker(room: Room, playerId: string): boolean {
  return room.settings.seekerId === playerId;
}

export function toClientRoom(room: Room): ClientRoom {
  return {
    code: room.code,
    settings: { ...room.settings },
    ownerId: room.ownerId,
    players: [...room.players.values()],
    playerCount: room.players.size,
    hideCount: room.hides.size,
    phase: room.phase,
    roundNo: room.roundNo,
    hidingEndsAtMs: room.hidingEndsAtMs,
    seekingEndsAtMs: room.seekingEndsAtMs,
  };
}

/** Lobby ops only make sense between rounds. */
export function requireIdlePhase(room: Room): void {
  if (room.phase !== 'LOBBY' && room.phase !== 'RESULTS') {
    throw new RoomError('ROUND_ACTIVE', `Round ${room.roundNo} is running — wait for results`);
  }
}

/** Lock a Street View hide. Re-locking overwrites (until the phase machine gates it). */
export function setHide(
  code: string,
  playerId: string,
  lat: number,
  lng: number,
  panoId: string,
  nowMs: number = Date.now(),
): { room: Room; hide: Hide } {
  const room = getRoom(code);
  if (!room) throw new RoomError('ROOM_NOT_FOUND', `Room ${normalizeCode(code)} not found`);
  if (room.phase !== 'HIDING') throw new RoomError('WRONG_PHASE', 'Hides lock during the hiding phase only');
  if (room.hidingEndsAtMs !== undefined && nowMs > room.hidingEndsAtMs) {
    throw new RoomError('WRONG_PHASE', 'Hiding is closed');
  }
  const player = room.players.get(playerId);
  if (!player) throw new RoomError('NOT_IN_ROOM', 'Player not in room');
  if (!player.connected) throw new RoomError('OFFLINE', 'Disconnected players cannot lock a hide');
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new RoomError('INVALID_PIN', 'Latitude must be -90..90');
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new RoomError('INVALID_PIN', 'Longitude must be -180..180');
  }
  if (typeof panoId !== 'string' || panoId.trim().length === 0) {
    throw new RoomError('NO_PANO', 'A Street View panorama within 50m is required to lock');
  }
  const hide: Hide = { playerId, lat, lng, panoId: panoId.trim() };
  room.hides.set(playerId, hide);
  return { room, hide };
}

/**
 * Anonymized teammate pins (rounded, no identity/panoId) so hiders can
 * avoid duplicate spots. Anti-cheat is out of scope for v1.
 */
export function anonymizedPins(room: Room): Array<{ lat: number; lng: number }> {
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  return [...room.hides.values()].map((h) => ({ lat: round3(h.lat), lng: round3(h.lng) }));
}

/** The single-round seeker (multi-seeker Teams handling lands in a later step). */
function requireSeeker(room: Room, playerId: string | undefined): Player {
  const player = (playerId && room.players.get(playerId)) || null;
  if (!player) throw new RoomError('NOT_IN_ROOM', 'Player not in room');
  if (!player.connected) throw new RoomError('OFFLINE', 'Disconnected players cannot seek');
  if (room.settings.seekerId !== player.id) throw new RoomError('NOT_SEEKER', 'Only the seeker can do this');
  return player;
}

function requireTargetHider(room: Room, targetHiderId: string): { target: Player; hide: Hide } {
  const target = room.players.get(targetHiderId);
  if (!target) throw new RoomError('NOT_IN_ROOM', 'Target hider not in room');
  if (target.id === room.settings.seekerId) throw new RoomError('SELF_GUESS', 'Cannot guess yourself');
  const hide = room.hides.get(targetHiderId);
  if (!hide) throw new RoomError('NO_HIDE', `${target.name} has no locked hide`);
  return { target, hide };
}

/** Seeking actions only make sense while the seeking clock runs. */
function requireSeekingPhase(room: Room): void {
  if (room.phase !== 'SEEKING') throw new RoomError('WRONG_PHASE', 'Seeking is not running');
}

/** Seeker opens a hider's locked panorama (panoId only — no coordinates leak). */
export function getHideForSeeker(
  code: string,
  seekerId: string | undefined,
  targetHiderId: string,
): { room: Room; target: Player; panoId: string } {
  const room = getRoom(code);
  if (!room) throw new RoomError('ROOM_NOT_FOUND', `Room ${normalizeCode(code)} not found`);
  requireSeekingPhase(room);
  requireSeeker(room, seekerId);
  const { target, hide } = requireTargetHider(room, targetHiderId);
  return { room, target, panoId: hide.panoId };
}

function checkGuessPin(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new RoomError('INVALID_PIN', 'Latitude must be -90..90');
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new RoomError('INVALID_PIN', 'Longitude must be -180..180');
  }
}

/**
 * Lock a guess: haversine distance + tier/points from `config/scoring.ts`.
 * Re-locking the same hider overwrites (until the phase machine gates it).
 */
export function setGuess(
  code: string,
  seekerId: string | undefined,
  targetHiderId: string,
  lat: number,
  lng: number,
): { room: Room; guess: Guess; tier: Tier } {
  const room = getRoom(code);
  if (!room) throw new RoomError('ROOM_NOT_FOUND', `Room ${normalizeCode(code)} not found`);
  requireSeekingPhase(room);
  const seeker = requireSeeker(room, seekerId);
  const { hide } = requireTargetHider(room, targetHiderId);
  checkGuessPin(lat, lng);
  const distanceKm = haversineKm(hide.lat, hide.lng, lat, lng);
  const { tier, points } = scoreGuess(distanceKm, room.settings.mapScale);
  const guess: Guess = { seekerId: seeker.id, targetHiderId, lat, lng, distanceKm, points };
  const idx = room.guesses.findIndex(
    (g) => g.seekerId === seeker.id && g.targetHiderId === targetHiderId,
  );
  if (idx >= 0) room.guesses[idx] = guess;
  else room.guesses.push(guess);
  return { room, guess, tier };
}

function requireOwner(room: Room, requesterId: string | undefined): void {
  if (!requesterId || requesterId !== room.ownerId) {
    throw new RoomError('NOT_OWNER', 'Only the room owner can do this');
  }
}

/** Owner updates lobby settings. Seeker seat is kept only if still connected. */
export function updateSettings(
  code: string,
  requesterId: string | undefined,
  patch: Partial<RoomSettings>,
): { room: Room } {
  const room = getRoom(code);
  if (!room) throw new RoomError('ROOM_NOT_FOUND', `Room ${normalizeCode(code)} not found`);
  requireOwner(room, requesterId);
  requireIdlePhase(room);
  const merged: RoomSettings = { ...room.settings, ...patch, regionId: patch.regionId ?? room.settings.regionId };
  const err = validateSettings(merged);
  if (err) throw new RoomError('INVALID_SETTINGS', err);
  if (merged.seekerId !== undefined) {
    const seeker = room.players.get(merged.seekerId);
    if (!seeker || !seeker.connected) delete merged.seekerId;
  }
  room.settings = merged;
  return { room };
}

export type SeekerSelection = { mode: 'random' } | { playerId: string };

/** Owner assigns the seeker: random (connected players only) or explicit pick. */
export function pickSeeker(
  code: string,
  requesterId: string | undefined,
  sel: SeekerSelection,
): { room: Room; seeker: Player } {
  const room = getRoom(code);
  if (!room) throw new RoomError('ROOM_NOT_FOUND', `Room ${normalizeCode(code)} not found`);
  requireOwner(room, requesterId);
  requireIdlePhase(room);
  let seeker: Player | undefined;
  if ('playerId' in sel) {
    seeker = room.players.get(sel.playerId);
    if (!seeker) throw new RoomError('NOT_IN_ROOM', 'Player not in room');
    if (!seeker.connected) throw new RoomError('SEEKER_OFFLINE', 'Seeker must be a connected player');
  } else {
    const candidates = [...room.players.values()].filter((p) => p.connected);
    if (candidates.length === 0) throw new RoomError('NO_CANDIDATES', 'No connected players to pick from');
    seeker = candidates[randomBytes(1)[0] % candidates.length];
  }
  room.settings.seekerId = seeker.id;
  return { room, seeker };
}

/** Owner assigns (or clears with '') a player's team label. */
export function assignTeam(
  code: string,
  requesterId: string | undefined,
  playerId: string,
  team: string,
): { room: Room; player: Player } {
  const room = getRoom(code);
  if (!room) throw new RoomError('ROOM_NOT_FOUND', `Room ${normalizeCode(code)} not found`);
  requireOwner(room, requesterId);
  requireIdlePhase(room);
  const player = room.players.get(playerId);
  if (!player) throw new RoomError('NOT_IN_ROOM', 'Player not in room');
  const t = (team ?? '').trim();
  if (t.length > 12) throw new RoomError('INVALID_TEAM', 'Team name must be ≤12 chars');
  if (t === '') delete player.team;
  else player.team = t;
  return { room, player };
}

export function closeRoom(code: string): boolean {
  return rooms.delete(normalizeCode(code));
}
