// Wrapper for Google Maps JS API + Street View Service.
// - loadMaps(apiKey): inject the Maps JS <script> once (singleton).
// - getPanoramaId(lat, lng): panoId within PANO_RADIUS_M or null.
// - panoExists(lat, lng): cached + in-flight-coalesced wrapper.
// Regions without coverage are rejected upstream (region presets); the
// service returning ZERO_RESULTS means "no panorama near this pin".

/** Street View search radius in meters — locks require a pano within this. */
export const PANO_RADIUS_M = 50;
/** Overtime granted when a hider fails to lock before the hiding timer ends. */
export const HIDER_OVERTIME_SEC = 10;

export class MapsError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Minimal structural view of the Maps JS pieces we use (no @types dep). */
interface StreetViewService {
  getPanorama(
    req: { location: { lat: number; lng: number }; radius: number; source: string },
    cb: (data: { location?: { pano?: string } | null } | null, status: string) => void,
  ): void;
}

function getStreetViewServiceCtor(): (new () => StreetViewService) | null {
  const g = (globalThis as { google?: unknown }).google as
    | { maps?: { StreetViewService?: new () => StreetViewService } }
    | undefined;
  return g?.maps?.StreetViewService ?? null;
}

export function isMapsLoaded(): boolean {
  return getStreetViewServiceCtor() !== null;
}

function resolveApiKey(explicit?: string): string {
  const envKey = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_MAPS_API_KEY;
  const key = (explicit ?? envKey ?? '').trim();
  if (!key) {
    throw new MapsError(
      'MISSING_KEY',
      'Set VITE_MAPS_API_KEY in .env (same Google Maps Platform key as MAPS_API_KEY)',
    );
  }
  return key;
}

let loadPromise: Promise<void> | null = null;

/** Load the Maps JS API once; concurrent callers share the promise. */
export function loadMaps(apiKey?: string): Promise<void> {
  if (isMapsLoaded()) return Promise.resolve();
  if (loadPromise) return loadPromise;
  // Validate synchronously BEFORE caching the promise, so a bad key/DOM
  // rejects without poisoning later calls.
  let key: string;
  try {
    key = resolveApiKey(apiKey);
  } catch (e) {
    return Promise.reject(e);
  }
  if (typeof document === 'undefined') {
    return Promise.reject(new MapsError('NO_DOM', 'Maps JS requires a browser DOM'));
  }
  loadPromise = new Promise<void>((resolve, reject) => {
    if (document.getElementById('ghns-maps-js')) {
      // Script tag already present (e.g. HMR) — poll briefly for the API.
      const started = Date.now();
      const timer = setInterval(() => {
        if (isMapsLoaded()) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 15000) {
          clearInterval(timer);
          loadPromise = null;
          reject(new MapsError('LOAD_TIMEOUT', 'Google Maps JS did not finish loading'));
        }
      }, 100);
      return;
    }
    const cbName = '__ghnsMapsReady';
    const w = window as unknown as Record<string, unknown>;
    w[cbName] = () => {
      delete w[cbName];
      resolve();
    };
    const script = document.createElement('script');
    script.id = 'ghns-maps-js';
    script.async = true;
    script.defer = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&callback=${cbName}`;
    script.onerror = () => {
      delete w[cbName];
      script.remove();
      loadPromise = null;
      reject(new MapsError('LOAD_FAILED', 'Could not load Google Maps JS (check key + billing)'));
    };
    setTimeout(() => {
      if (!isMapsLoaded() && document.getElementById('ghns-maps-js')) {
        script.remove();
        delete w[cbName];
        loadPromise = null;
        reject(new MapsError('LOAD_TIMEOUT', 'Google Maps JS did not finish loading'));
      }
    }, 15000);
    document.head.appendChild(script);
  });
  return loadPromise;
}

/** Raw panorama lookup. null = ZERO_RESULTS (no coverage near pin). */
export function getPanoramaId(lat: number, lng: number, radiusM = PANO_RADIUS_M): Promise<string | null> {
  const Ctor = getStreetViewServiceCtor();
  if (!Ctor) return Promise.reject(new MapsError('MAPS_NOT_LOADED', 'Call loadMaps() first'));
  return new Promise<string | null>((resolve, reject) => {
    try {
      new Ctor().getPanorama(
        { location: { lat, lng }, radius: radiusM, source: 'outdoor' },
        (data, status) => {
          if (status === 'OK') {
            const pano = data?.location?.pano;
            resolve(typeof pano === 'string' && pano.length > 0 ? pano : null);
          } else if (status === 'ZERO_RESULTS') {
            resolve(null);
          } else {
            reject(new MapsError('PANORAMA_ERROR', `Street View lookup failed (${status})`));
          }
        },
      );
    } catch (e) {
      reject(e instanceof Error ? e : new MapsError('PANORAMA_ERROR', 'Street View lookup failed'));
    }
  });
}

const cache = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

export function panoCacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

/** Cached; concurrent callers for the same pin share one service request. */
export function panoExists(lat: number, lng: number): Promise<string | null> {
  const key = panoCacheKey(lat, lng);
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const req = getPanoramaId(lat, lng).then(
    (panoId) => {
      inFlight.delete(key);
      cache.set(key, panoId);
      return panoId;
    },
    (err) => {
      inFlight.delete(key);
      throw err;
    },
  );
  inFlight.set(key, req);
  return req;
}

export function clearPanoCache(): void {
  cache.clear();
  inFlight.clear();
}

/** Trailing debounce for UI-driven checks (e.g. pin drags). */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
}
