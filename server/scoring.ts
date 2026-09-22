import {
  FOUND_POINTS,
  MISS_POINTS,
  PARTIAL_MAX_POINTS,
  PARTIAL_MIN_POINTS,
  SCORING,
  type MapScale,
} from '../config/scoring.js';

export type Tier = 'FOUND' | 'PARTIAL' | 'MISS';

/** Great-circle distance in kilometers. */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Score a guess per `config/scoring.ts` thresholds:
 * FOUND (1000) | PARTIAL (100-999, linear foundKm→999 down to partialKm→100) | MISS (0).
 */
export function scoreGuess(distanceKm: number, mapScale: MapScale): { tier: Tier; points: number } {
  const t = SCORING[mapScale];
  if (!t) throw new Error(`Unknown mapScale ${mapScale}`);
  const d = Math.max(0, distanceKm);
  if (d <= t.foundKm) return { tier: 'FOUND', points: FOUND_POINTS };
  if (d > t.partialKm) return { tier: 'MISS', points: MISS_POINTS };
  const span = t.partialKm - t.foundKm;
  const frac = span <= 0 ? 0 : (d - t.foundKm) / span;
  const points = Math.round(PARTIAL_MAX_POINTS - frac * (PARTIAL_MAX_POINTS - PARTIAL_MIN_POINTS));
  return { tier: 'PARTIAL', points };
}
