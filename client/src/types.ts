// Shared client-side shapes — mirrors server/rooms.ts contracts exactly.
export type MapScale = 'WORLD' | 'CONTINENT' | 'COUNTRY' | 'CITY';
export type GameMode = 'CLASSIC' | '1V1' | 'TEAMS';

export interface RoomSettings {
  mapScale: MapScale;
  regionId: string;
  hidingTimeSec: number;
  seekingTimeSec: number;
  bonusTimeSec: number;
  mode: GameMode;
  seekerId?: string;
}

export interface Player {
  id: string;
  name: string;
  team?: string;
  connected: boolean;
  score: number;
}

export interface Guess {
  seekerId: string;
  targetHiderId: string;
  lat: number;
  lng: number;
  distanceKm: number;
  points: number;
}

export type Phase = 'LOBBY' | 'HIDING' | 'SEEKING' | 'RESULTS';

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
