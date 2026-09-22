import { getSocket } from '../socket';
import { ensureSession, loadSession } from '../session';
import { regionCenter } from '../regions';
import { MapsError, debounce, loadMaps, panoExists } from '../maps';
import type { ClientRoom, Guess, Player } from '../types';
import type { Socket } from 'socket.io-client';

interface AckRes {
  ok: boolean;
  panoId?: string;
  guess?: Guess;
  tier?: string;
  error?: string;
  code?: string;
}

function emitAck(socket: Socket, ev: string, payload: unknown): Promise<AckRes> {
  return new Promise((resolve) => {
    socket.emit(ev, payload, (res: AckRes) => resolve(res));
  });
}

function gmaps(): any | null {
  return (globalThis as { google?: { maps?: unknown } }).google?.maps ?? null;
}

/**
 * SeekView: hider list, locked panorama viewer (pan/zoom, no movement),
 * guess map + Check Street View + Lock Guess per hider, live
 * seeker-activity broadcast (viewHide/previewGuess → hiders spectate).
 * Activates on the server `seeking:started` event (round flow);
 * `?view=seek` forces it visible for manual testing.
 */
export function SeekView(): HTMLElement {
  const socket = getSocket();
  const previewMode = new URLSearchParams(location.search).get('view') === 'seek';
  const el = document.createElement('section');
  el.hidden = !previewMode;

  let room: ClientRoom | null = null;
  let map: any | null = null;
  let marker: any | null = null;
  let mapReady = false;
  let mapError = '';
  let selectedId: string | null = null;
  let guessPin: { lat: number; lng: number } | null = null;
  let guessPinHasPano: boolean | null = null;
  let guessPanoId: string | null = null;
  let checkingPin = false;
  let guesses = new Map<string, Guess>();
  let noHide = new Set<string>();
  let seekEndsAtMs: number | null = null;

  el.innerHTML = `
    <div class="card">
      <h2>Seek the hiders</h2>
      <p class="hint" data-s="status">Waiting for the seeking phase…</p>
      <p class="hint" data-s="me"></p>
      <p class="hint" data-s="timer"></p>
      <ul class="players" data-s="hiders"></ul>
      <p class="hint" data-s="activity"></p>
      <div data-s="pano" style="height:260px;border-radius:8px;overflow:hidden;background:#0f1419"></div>
      <p class="hint" data-s="viewline">Pick a hider to load their panorama.</p>
      <div data-s="guessbox">
      <h3>Your guess</h3>
      <div data-s="map" style="height:300px;border-radius:8px;overflow:hidden;background:#0f1419"></div>
      <p class="hint" data-s="pinline">Click the guess map to place your pin.</p>
      <div class="row" style="margin-top:12px">
        <button data-act="check" class="secondary">Check Street View</button>
        <button data-act="lock">Lock Guess</button>
      </div>
      <div data-s="guesspano" style="height:200px;border-radius:8px;overflow:hidden;margin-top:12px;background:#0f1419"></div>
      </div>
      <p class="hint" data-s="result"></p>
      <p class="error" data-s="error"></p>
      <p class="notice" data-s="notice"></p>
    </div>`;

  const q = <T extends HTMLElement = HTMLElement>(sel: string): T => el.querySelector(sel) as T;
  const statusLine = q('[data-s="status"]');
  const meLine = q('[data-s="me"]');
  const timerLine = q('[data-s="timer"]');
  const hidersUl = q('[data-s="hiders"]');
  const activityLine = q('[data-s="activity"]');
  const guessBox = q('[data-s="guessbox"]');
  const panoDiv = q('[data-s="pano"]');
  const viewLine = q('[data-s="viewline"]');
  const mapDiv = q('[data-s="map"]');
  const pinLine = q('[data-s="pinline"]');
  const guessPanoDiv = q('[data-s="guesspano"]');
  const resultLine = q('[data-s="result"]');
  const errorLine = q('[data-s="error"]');
  const noticeLine = q('[data-s="notice"]');
  const checkBtn = q<HTMLButtonElement>('[data-act="check"]');
  const lockBtn = q<HTMLButtonElement>('[data-act="lock"]');

  const code = () => loadSession()?.code ?? '';
  const myId = () => loadSession()?.playerId ?? null;
  const myName = () =>
    room?.players.find((p) => p.id === myId())?.name ?? loadSession()?.name ?? '';
  const isSeeker = () => !!room && !!myId() && room.settings.seekerId === myId();
  const hiders = (): Player[] => room?.players.filter((p) => p.id !== room?.settings.seekerId) ?? [];
  const seekingClosed = () => seekEndsAtMs !== null && Date.now() >= seekEndsAtMs;
  const nameOf = (id: string) => room?.players.find((p) => p.id === id)?.name ?? 'a hider';
  let activity = '';

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  }

  function render() {
    const seeker = room?.players.find((p) => p.id === room?.settings.seekerId);
    const spectate = !!room && !isSeeker() && !previewMode;
    guessBox.style.display = spectate ? 'none' : '';
    panoDiv.style.display = spectate ? 'none' : '';
    viewLine.style.display = spectate ? 'none' : '';
    meLine.textContent = room && myName() ? `Playing as ${myName()}.` : '';
    activityLine.textContent = room ? activity || 'Waiting for seeker activity…' : '';
    if (!room) {
      statusLine.textContent = 'Waiting for the seeking phase…';
    } else if (!isSeeker()) {
      statusLine.textContent = seeker
        ? `${seeker.name} is seeking — your panorama may be under review.`
        : 'Waiting for the seeking phase…';
    } else {
      const remaining = hiders().filter((h) => !guesses.has(h.id) && !noHide.has(h.id));
      statusLine.textContent =
        remaining.length === 0 && hiders().length > 0
          ? 'All hiders guessed.'
          : `Seeking as ${seeker?.name ?? 'seeker'} — ${remaining.length} hider(s) left to guess.`;
    }
    if (seekEndsAtMs !== null) {
      const left = Math.max(0, Math.ceil((seekEndsAtMs - Date.now()) / 1000));
      timerLine.textContent = seekingClosed() ? 'Seeking time expired.' : `Seeking ends in ${left}s`;
    } else {
      timerLine.textContent = '';
    }
    hidersUl.innerHTML = '';
    for (const h of hiders()) {
      const li = document.createElement('li');
      const g = guesses.get(h.id);
      const tags = [
        g ? `<span class="badge seeker">${g.points} pts</span>` : '',
        noHide.has(h.id) ? '<span class="badge offline">no hide</span>' : '',
        h.connected ? '' : '<span class="badge offline">offline</span>',
      ].join('');
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.textContent = h.id === selectedId ? `Viewing: ${h.name}` : h.name;
      btn.disabled = !isSeeker();
      btn.addEventListener('click', () => void selectHider(h.id));
      li.appendChild(btn);
      li.insertAdjacentHTML('beforeend', ` ${tags}`);
      hidersUl.appendChild(li);
    }
    const sel = hiders().find((h) => h.id === selectedId);
    viewLine.textContent = sel ? `Viewing ${sel.name}'s panorama (pan/zoom only).` : 'Pick a hider to load their panorama.';
    pinLine.textContent = guessPin
      ? `Guess pin: ${guessPin.lat.toFixed(5)}, ${guessPin.lng.toFixed(5)} — ${
          checkingPin ? 'checking Street View…' : guessPinHasPano ? 'Street View here.' : 'no panorama nearby (guess still allowed).'
        }`
      : 'Click the guess map to place your pin.';
    const canLock = isSeeker() && !!selectedId && !!guessPin && !seekingClosed() && !guesses.has(selectedId);
    lockBtn.disabled = !canLock;
    checkBtn.disabled = !guessPin || checkingPin || !isSeeker();
    if (mapError) errorLine.textContent = mapError;
  }

  async function ensureMap() {
    if (mapReady || mapError) return;
    try {
      await loadMaps();
    } catch (e) {
      mapError =
        e instanceof MapsError && e.code === 'MISSING_KEY'
          ? 'Set VITE_MAPS_API_KEY in .env (see README) to load the map.'
          : `Map failed to load (${e instanceof Error ? e.message : 'unknown error'})`;
      render();
      return;
    }
    const maps = gmaps();
    if (!maps) {
      mapError = 'Map failed to load.';
      render();
      return;
    }
    const c = regionCenter(room?.settings.regionId);
    map = new maps.Map(mapDiv, { center: { lat: c.lat, lng: c.lng }, zoom: c.zoom, clickableIcons: false });
    marker = new maps.Marker({ map, draggable: true, visible: false });
    marker.addListener('dragend', () => {
      const pos = marker.getPosition();
      if (pos && isSeeker() && !seekingClosed()) setGuessPin({ lat: pos.lat(), lng: pos.lng() });
    });
    map.addListener('click', (e: { latLng?: { lat(): number; lng(): number } | null }) => {
      if (!e.latLng || !isSeeker() || seekingClosed()) return;
      setGuessPin({ lat: e.latLng.lat(), lng: e.latLng.lng() });
    });
    mapReady = true;
    render();
  }

  async function selectHider(id: string) {
    errorLine.textContent = '';
    resultLine.textContent = '';
    const res = await emitAck(socket, 'viewHide', { code: code(), targetHiderId: id });
    if (!res.ok || !res.panoId) {
      if (res.code === 'NO_HIDE') {
        noHide.add(id);
        errorLine.textContent = 'That hider has no locked hide.';
        render();
        return;
      }
      errorLine.textContent = res.error ?? 'Could not load panorama';
      return;
    }
    selectedId = id;
    guessPin = null;
    guessPinHasPano = null;
    guessPanoId = null;
    guessPanoDiv.innerHTML = '';
    marker?.setVisible(false);
    if (!showPanoById(res.panoId)) return;
    render();
  }

  /** Render a hider's panorama by id, surfacing failures instead of staying black. */
  function showPanoById(id: string): boolean {
    const maps = gmaps();
    if (!maps) {
      errorLine.textContent = 'Map is not loaded yet.';
      return false;
    }
    try {
      const viewer = new maps.StreetViewPanorama(panoDiv, {
        pano: id,
        pov: { heading: 0, pitch: 0 },
        zoom: 1,
        linksControl: false,
        addressControl: false,
        clickToGo: false,
      });
      viewer.addListener('status_changed', () => {
        try {
          if (viewer.getStatus() !== 'OK') {
            errorLine.textContent = `Panorama failed to load (${viewer.getStatus()}).`;
          }
        } catch {
          // Ignore status probe errors.
        }
      });
      return true;
    } catch (e) {
      errorLine.textContent = `Panorama failed to load (${e instanceof Error ? e.message : 'unknown error'}).`;
      return false;
    }
  }

  function setGuessPin(next: { lat: number; lng: number }) {
    guessPin = next;
    guessPinHasPano = null;
    guessPanoId = null;
    guessPanoDiv.innerHTML = '';
    marker?.setPosition(next);
    marker?.setVisible(true);
    render();
    void debouncedPreview(next.lat, next.lng);
  }

  const debouncedPreview = debounce((lat: number, lng: number) => {
    if (!selectedId || !isSeeker()) return;
    // Fire-and-forget: the server broadcasts the coarse region to hiders.
    socket.emit('previewGuess', { code: code(), targetHiderId: selectedId, lat, lng });
    void checkGuessPin(lat, lng);
  }, 500);

  async function checkGuessPin(lat: number, lng: number) {
    checkingPin = true;
    render();
    try {
      guessPanoId = await panoExists(lat, lng);
      guessPinHasPano = guessPanoId !== null;
    } catch {
      guessPanoId = null;
      guessPinHasPano = null;
    } finally {
      if (guessPin && Math.abs(guessPin.lat - lat) < 1e-9 && Math.abs(guessPin.lng - lng) < 1e-9) {
        checkingPin = false;
        render();
        // Show the pin's Street View right away — no extra click needed.
        if (guessPanoId) showGuessPano(guessPanoId);
      }
    }
  }

  /** Render the guess pin's own Street View so the seeker can compare. */
  function showGuessPano(id: string): boolean {
    const maps = gmaps();
    if (!maps) {
      errorLine.textContent = 'Map is not loaded yet.';
      return false;
    }
    try {
      const viewer = new maps.StreetViewPanorama(guessPanoDiv, {
        pano: id,
        pov: { heading: 0, pitch: 0 },
        zoom: 1,
        linksControl: false,
        addressControl: false,
        clickToGo: false,
      });
      viewer.addListener('status_changed', () => {
        try {
          if (viewer.getStatus() !== 'OK') {
            errorLine.textContent = `Guess-pin Street View failed to load (${viewer.getStatus()}).`;
          }
        } catch {
          // Ignore status probe errors.
        }
      });
      return true;
    } catch (e) {
      errorLine.textContent = `Guess-pin Street View failed to load (${e instanceof Error ? e.message : 'unknown error'}).`;
      return false;
    }
  }

  function doCheck() {
    errorLine.textContent = '';
    if (!guessPin) {
      errorLine.textContent = 'Place a guess pin first.';
      return;
    }
    // Re-run coverage (auto-displays the panorama when found).
    void checkGuessPin(guessPin.lat, guessPin.lng);
  }

  async function doLock() {
    errorLine.textContent = '';
    if (!selectedId || !guessPin) return;
    const res = await emitAck(socket, 'lockGuess', {
      code: code(),
      targetHiderId: selectedId,
      lat: guessPin.lat,
      lng: guessPin.lng,
    });
    if (!res.ok || !res.guess) {
      errorLine.textContent = res.error ?? 'Lock failed';
      return;
    }
    guesses.set(selectedId, res.guess);
    resultLine.textContent =
      `${res.tier} — ${res.guess.points} pts (${res.guess.distanceKm.toFixed(2)} km).`;
    // Advance to the next unguessed hider with a hide.
    const next = hiders().find((h) => !guesses.has(h.id) && !noHide.has(h.id) && h.id !== selectedId);
    render();
    if (next) void selectHider(next.id);
  }

  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'check') doCheck();
    else if (act === 'lock') void doLock();
  });

  socket.on('room:state', (payload: { room: ClientRoom }) => {
    if (payload.room.code === code()) {
      room = payload.room;
      render();
    }
  });
  socket.on('seeking:started', (payload: { roomCode: string; deadlineMs: number }) => {
    if (payload.roomCode !== code()) return;
    el.hidden = false;
    guesses = new Map();
    noHide = new Set();
    selectedId = null;
    seekEndsAtMs = payload.deadlineMs;
    void ensureMap();
    render();
  });
  socket.on('guess:locked', (payload: { roomCode: string; guess: Guess }) => {
    if (payload.roomCode !== code()) return;
    guesses.set(payload.guess.targetHiderId, payload.guess);
    render();
  });
  socket.on('seeker:viewing', (payload: { roomCode: string; targetHiderId: string }) => {
    if (payload.roomCode !== code()) return;
    activity = `Seeker is viewing ${nameOf(payload.targetHiderId)}.`;
    render();
  });
  socket.on(
    'seeker:guessing',
    (payload: { roomCode: string; targetHiderId: string; region: { lat: number; lng: number } }) => {
      if (payload.roomCode !== code()) return;
      activity =
        `Seeker guess pin near ${payload.region.lat}, ${payload.region.lng} ` +
        `for ${nameOf(payload.targetHiderId)}.`;
      render();
    },
  );
  socket.on('seeking:time-updated', (payload: { roomCode: string; deadlineMs: number; bonusSec: number }) => {
    if (payload.roomCode !== code()) return;
    seekEndsAtMs = payload.deadlineMs;
    noticeLine.textContent = `Seeker found a hider — +${payload.bonusSec}s on the clock.`;
    render();
  });
  socket.on('hiding:started', (payload: { roomCode: string }) => {
    if (payload.roomCode !== code() || previewMode) return;
    el.hidden = true;
  });
  socket.on('round:ended', (payload: { roomCode: string }) => {
    if (payload.roomCode !== code() || previewMode) return;
    el.hidden = true;
  });

  setInterval(() => {
    if (seekEndsAtMs !== null && !el.hidden) render();
  }, 500);
  if (previewMode) void ensureMap();
  // Rebind this tab's seat after reload/reconnect; then refresh.
  void ensureSession(socket).then((r) => {
    if (r.session && !r.restored) {
      errorLine.textContent = 'Session not restored — rejoin from the lobby if seeking stops working.';
    }
    render();
  });
  socket.on('reconnect', () => {
    void ensureSession(socket).then(() => render());
  });
  render();
  return el;
}
