// Region presets with verified Street View coverage.
// MUST match server/rooms.ts REGION_PRESETS — the server rejects anything else.
import type { MapScale } from './types';

export interface RegionPreset {
  id: string;
  label: string;
  scale: MapScale;
  /** Initial map center/zoom for HideView (client-only; id/label/scale mirror the server). */
  center: [number, number];
  zoom: number;
}

export const REGION_PRESETS: RegionPreset[] = [
  { id: 'world', label: 'World', scale: 'WORLD', center: [20, 0], zoom: 2 },
  { id: 'europe', label: 'Europe', scale: 'CONTINENT', center: [50, 10], zoom: 4 },
  { id: 'asia', label: 'Asia', scale: 'CONTINENT', center: [35, 100], zoom: 3 },
  { id: 'north-america', label: 'North America', scale: 'CONTINENT', center: [40, -100], zoom: 3 },
  { id: 'africa', label: 'Africa', scale: 'CONTINENT', center: [5, 20], zoom: 3 },
  { id: 'united-states', label: 'United States', scale: 'COUNTRY', center: [39, -98], zoom: 4 },
  { id: 'france', label: 'France', scale: 'COUNTRY', center: [47, 2], zoom: 6 },
  { id: 'japan', label: 'Japan', scale: 'COUNTRY', center: [36, 138], zoom: 5 },
  { id: 'brazil', label: 'Brazil', scale: 'COUNTRY', center: [-10, -55], zoom: 4 },
  { id: 'paris', label: 'Paris', scale: 'CITY', center: [48.85, 2.35], zoom: 12 },
  { id: 'tokyo', label: 'Tokyo', scale: 'CITY', center: [35.68, 139.69], zoom: 12 },
  { id: 'new-york', label: 'New York', scale: 'CITY', center: [40.71, -74.0], zoom: 12 },
];

export function regionsFor(scale: MapScale): RegionPreset[] {
  return REGION_PRESETS.filter((r) => r.scale === scale);
}

/** Map center/zoom for a region id (world fallback for unknown ids). */
export function regionCenter(regionId: string | undefined): { lat: number; lng: number; zoom: number } {
  const preset = REGION_PRESETS.find((r) => r.id === regionId);
  if (preset) return { lat: preset.center[0], lng: preset.center[1], zoom: preset.zoom };
  return { lat: 20, lng: 0, zoom: 2 };
}

export const MODE_INFO: Record<string, string> = {
  CLASSIC: '1 seeker vs 2-9 hiders',
  '1V1': '1 seeker vs 1 hider (needs exactly 2 players)',
  TEAMS: 'N seekers vs M hiders (owner assigns teams)',
};
