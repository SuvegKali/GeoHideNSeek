/**
 * Tunable scoring thresholds — edit values here, no code changes needed.
 * Distances in kilometers. Points: FOUND = 1000, MISS = 0,
 * PARTIAL scales linearly from 999 (at foundKm) down to 100 (at partialKm).
 */
export type MapScale = 'WORLD' | 'CONTINENT' | 'COUNTRY' | 'CITY';

export interface ScaleThresholds {
  /** <= this distance counts as FOUND (1000 pts) */
  foundKm: number;
  /** <= this distance counts as PARTIAL (100-999 pts), else MISS (0) */
  partialKm: number;
  /** points awarded to a hider who remains unfound at round end */
  hiderSurvivalPts: number;
}

export const SCORING: Record<MapScale, ScaleThresholds> = {
  WORLD: { foundKm: 10, partialKm: 50, hiderSurvivalPts: 500 },
  CONTINENT: { foundKm: 5, partialKm: 25, hiderSurvivalPts: 500 },
  COUNTRY: { foundKm: 2, partialKm: 10, hiderSurvivalPts: 500 },
  CITY: { foundKm: 0.5, partialKm: 2, hiderSurvivalPts: 500 },
};

export const FOUND_POINTS = 1000;
export const MISS_POINTS = 0;
export const PARTIAL_MIN_POINTS = 100;
export const PARTIAL_MAX_POINTS = 999;
