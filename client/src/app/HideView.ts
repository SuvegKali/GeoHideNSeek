import { getSocket } from '../socket';
import { ensureSession, loadSession } from '../session';
import { REGION_PRESETS } from '../regions';
import { HIDER_OVERTIME_SEC, MapsError, debounce, loadMaps, panoExists } from '../maps';
import { hidePhaseAt, hideRemainingSec } from '../hidePhase';
import type { ClientRoom, Guess } from '../types';
import type { Socket } from 'socket.io-client';

// The Maps JS objects we touch, structurally typed (no @types/google.maps dep).
type GMaps = any;
type GMap = any;
type GMarker = any;

interface AckRes {
  ok: boolean;
  error?: string;
  code?: string;
}

function emitAck(socket: Socket, ev: string, payload: unknown): Promise<AckRes> {
  return new Promise((resolve) => {
    socket.emit(ev, payload, (res: AckRes) => resolve(res));
  });
}

function gmaps(): GMaps | null {
  return (globalThis as { google?: { maps?: unknown } }).google?.maps ?? null;
}

/**
 * HideView: zoomable map + pin, Check Street View, Lock Hide, hiding timer
 * with 10s overtime skip. Activates on the server `hiding:started`
 * event (round flow); `?view=hide` forces it visible for manual testing.
 */
export function HideView(): HTMLElement {
  const socket = getSocket();
  const previewMode = new URLSearchParams(location.search).get('view') === 'hide';
  const el = document.createElement('section');
  el.hidden = !previewMode;

  let room: ClientRoom | null = null;
  let map: GMap | null = null;
  let marker: GMarker | null = null;
  let teamMarkers: GMarker[] = [];
  let mapReady = false;
  let mapError = '';
  let pin: { lat: number; lng: number } | null = null;
  let panoId: string | null = null;
  let checking = false;
  let locked = false;
  let skipped = false;
  let deadlineMs: number | null = null;
  let frozenNoticed = false;

  el.innerHTML = `
    <div class="card">
      <h2>Hide your spot</h2>
      <p class="hint" data-h="status">Waiting for the hiding phase…</p>
      <p class="hint" data-h="me"></p>
      <p class="hint" data-h="timer"></p>
      <div data-h="map" style="height:320px;border-radius:8px;overflow:hidden;background:#0f1419"></div>
      <p class="hint" data-h="pinline">Click the map to place your pin.</p>
      <div class="row" data-h="controls" style="margin-top:12px">
        <button data-act="check" class="secondary">Check Street View</button>
        <button data-act="lock">Lock Hide</button>
        <button data-act="preview-timer" class="secondary" data-h="preview-btn" hidden>Preview timer</button>
      </div>
      <div data-h="pano" style="height:220px;border-radius:8px;overflow:hidden;margin-top:12px;background:#0f1419"></div>
      <p class="hint" data-h="mates"></p>
      <p class="hint" data-h="spy"></p>
      <p class="error" data-h="error"></p>
      <p class="notice" data-h="notice"></p>
    </div>`;

  const q = <T extends HTMLElement = HTMLElement>(sel: string): T => el.querySelector(sel) as T;
  const statusLine = q('[data-h="status"]');
  const meLine = q('[data-h="me"]');
  const timerLine = q('[data-h="timer"]');
  const mapDiv = q('[data-h="map"]');
  const pinLine = q('[data-h="pinline"]');
  const controlsRow = q('[data-h="controls"]');
  const panoDiv = q('[data-h="pano"]');
  const matesLine = q('[data-h="mates"]');
  const spyLine = q('[data-h="spy"]');
  const errorLine = q('[data-h="error"]');
  const noticeLine = q('[data-h="notice"]');
  const checkBtn = q<HTMLButtonElement>('[data-act="check"]');
  const lockBtn = q<HTMLButtonElement>('[data-act="lock"]');
  const previewBtn = q<HTMLButtonElement>('[data-h="preview-btn"]');
  if (previewMode) previewBtn.hidden = false;

  const code = () => loadSession()?.code ?? '';
  const myId = () => loadSession()?.playerId ?? null;
  const myName = () =>
    room?.players.find((p) => p.id === myId())?.name ?? loadSession()?.name ?? '';
  const amSeeker = () => !!room && !!myId() && room.settings.seekerId === myId();
  const nameOf = (id: string) => room?.players.find((p) => p.id === id)?.name ?? 'a hider';
  /** Latest seeker probe marker per target hider. */
  let probes = new Map<string, any>();
  let spyFeed = '';

  function phaseNow() {
    if (deadlineMs === null) return 'active' as const;
    return hidePhaseAt(Date.now(), deadlineMs, HIDER_OVERTIME_SEC);
  }

  function frozen() {
    return amSeeker() || locked || skipped || phaseNow() !== 'active';
  }

  function render() {
    const seekerView = amSeeker();
    const spectate = !!room && room.phase === 'SEEKING' && !seekerView && !previewMode;
    mapDiv.style.display = seekerView ? 'none' : '';
    pinLine.style.display = seekerView ? 'none' : '';
    controlsRow.style.display = seekerView || spectate ? 'none' : '';
    panoDiv.style.display = seekerView ? 'none' : '';
    meLine.textContent = room && myName() ? `Playing as ${myName()}.` : '';
    if (seekerView) {
      statusLine.textContent = 'You are the seeker this round — hiders are hiding.';
      timerLine.textContent =
        deadlineMs !== null && phaseNow() === 'active'
          ? `Hiding ends in ${hideRemainingSec(Date.now(), deadlineMs, HIDER_OVERTIME_SEC)}s`
          : '';
      matesLine.textContent = room ? `${room.hideCount} hide(s) locked in this room.` : '';
      spyLine.textContent = '';
      return;
    }
    if (spectate) {
      statusLine.textContent = 'Seeking live — watch the seeker work.';
      timerLine.textContent = '';
      matesLine.textContent = room ? `${room.hideCount} hide(s) locked in this room.` : '';
      spyLine.textContent = spyFeed || 'Waiting for seeker moves…';
      return;
    }
    spyLine.textContent = '';
    if (locked) {
      statusLine.textContent = 'Hide locked — good luck, seeker.';
    } else if (skipped) {
      statusLine.textContent = 'No lock in time — you sit out this round.';
    } else if (deadlineMs === null) {
      statusLine.textContent = previewMode
        ? 'Preview mode — place a pin, check Street View, lock.'
        : 'Waiting for the hiding phase…';
    } else if (phaseNow() === 'overtime') {
      statusLine.textContent = `Overtime — lock your hide now or sit out.`;
    } else {
      statusLine.textContent = 'Hiding open — place a pin with Street View coverage.';
    }
    if (deadlineMs !== null && !locked && !skipped) {
      const left = hideRemainingSec(Date.now(), deadlineMs, HIDER_OVERTIME_SEC);
      timerLine.textContent =
        phaseNow() === 'overtime' ? `Overtime ends in ${left}s` : `Hiding ends in ${left}s`;
    } else {
      timerLine.textContent = '';
    }
    pinLine.textContent = pin
      ? `Pin: ${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)} — ${
          checking ? 'checking Street View…' : panoId ? 'Street View found.' : 'no panorama within 50m.'
        }`
      : 'Click the map to place your pin.';
    lockBtn.disabled = !(pin && panoId && !locked && !skipped && phaseNow() !== 'closed');
    checkBtn.disabled = !pin || checking || locked || skipped;
    matesLine.textContent = room ? `${room.hideCount} hide(s) locked in this room.` : '';
    if (mapError) errorLine.textContent = mapError;
  }

  function regionCenter(): { lat: number; lng: number; zoom: number } {
    const preset = REGION_PRESETS.find((r) => r.id === room?.settings.regionId);
    if (preset) return { lat: preset.center[0], lng: preset.center[1], zoom: preset.zoom };
    return { lat: 20, lng: 0, zoom: 2 };
  }

  async function ensureMap() {
    if (mapReady || mapError) return;
    if (!code()) {
      mapError = 'Join a room from the lobby first.';
      render();
      return;
    }
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
    const c = regionCenter();
    map = new maps.Map(mapDiv, {
      center: { lat: c.lat, lng: c.lng },
      zoom: c.zoom,
      clickableIcons: false,
    });
    marker = new maps.Marker({ map, draggable: true, visible: false });
    marker.addListener('dragend', () => {
      if (frozen()) return;
      const pos = marker.getPosition();
      if (pos) setPin({ lat: pos.lat(), lng: pos.lng() });
    });
    map.addListener('click', (e: { latLng?: { lat(): number; lng(): number } | null }) => {
      if (frozen() || !e.latLng) return;
      setPin({ lat: e.latLng.lat(), lng: e.latLng.lng() });
    });
    mapReady = true;
    render();
  }

  function setPin(next: { lat: number; lng: number }) {
    pin = next;
    panoId = null;
    marker?.setPosition(next);
    marker?.setVisible(true);
    render();
    void debouncedCheck(next.lat, next.lng);
  }

  const debouncedCheck = debounce((lat: number, lng: number) => {
    void checkPano(lat, lng);
  }, 400);

  async function checkPano(lat: number, lng: number) {
    checking = true;
    render();
    try {
      panoId = await panoExists(lat, lng);
    } catch (e) {
      errorLine.textContent = `Street View check failed (${e instanceof Error ? e.message : 'unknown'})`;
      panoId = null;
    } finally {
      // Ignore stale responses after the pin moved on.
      if (pin && Math.abs(pin.lat - lat) < 1e-9 && Math.abs(pin.lng - lng) < 1e-9) {
        checking = false;
        render();
      }
    }
  }

  /** Render a panorama by id, surfacing load failures instead of staying black. */
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
            errorLine.textContent = `Street View failed to load (${viewer.getStatus()}).`;
          }
        } catch {
          // Ignore status probe errors.
        }
      });
      return true;
    } catch (e) {
      errorLine.textContent = `Street View failed to load (${e instanceof Error ? e.message : 'unknown error'}).`;
      return false;
    }
  }

  function doCheckView() {
    errorLine.textContent = '';
    noticeLine.textContent = '';
    if (!pin) {
      errorLine.textContent = 'Place a pin first.';
      return;
    }
    if (!panoId) {
      errorLine.textContent = 'No Street View panorama within 50m of this pin — move it.';
      return;
    }
    if (showPanoById(panoId)) {
      noticeLine.textContent = 'Panorama preview — the seeker cannot move from here either.';
    }
  }

  async function doLock(auto = false) {
    errorLine.textContent = '';
    if (!pin || !panoId || locked || skipped) return;
    const res = await emitAck(socket, 'lockHide', { code: code(), lat: pin.lat, lng: pin.lng, panoId });
    if (!res.ok) {
      if (!auto) errorLine.textContent = res.error ?? 'Lock failed';
      return;
    }
    locked = true;
    marker?.setDraggable(false);
    noticeLine.textContent = auto ? 'Pin frozen at timer end — hide auto-locked.' : 'Hide locked.';
    // Confirm what the seeker will see.
    if (panoId) showPanoById(panoId);
    render();
  }

  function tick() {
    if (deadlineMs === null || locked || skipped) return;
    const phase = phaseNow();
    if (phase !== 'active' && !frozenNoticed) {
      frozenNoticed = true;
      marker?.setDraggable(false);
      // Best effort: freeze the pin into a lock if coverage is confirmed.
      if (panoId) void doLock(true);
    }
    if (phase === 'closed') {
      skipped = true;
      render();
      return;
    }
    render();
  }

  function renderTeamPins(pins: Array<{ lat: number; lng: number }>) {
    if (!mapReady) return;
    const maps = gmaps();
    if (!maps) return;
    teamMarkers.forEach((m) => m.setMap(null));
    teamMarkers = pins.map(
      (p) => new maps.Marker({ position: p, map, title: 'teammate hide', opacity: 0.65 }),
    );
  }

  function clearProbes() {
    probes.forEach((m) => {
      try {
        m.setMap(null);
      } catch {
        // Ignore teardown errors.
      }
    });
    probes = new Map();
  }

  /** Latest seeker probe per target hider, right on the hide map. */
  function upsertProbe(targetId: string, at: { lat: number; lng: number }) {
    if (!mapReady) return;
    const maps = gmaps();
    if (!maps) return;
    try {
      probes.get(targetId)?.setMap(null);
      probes.set(
        targetId,
        new maps.Marker({ position: at, map, title: `Seeker probe (${nameOf(targetId)})`, label: 'S' }),
      );
    } catch {
      // Ignore marker errors.
    }
  }

  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'check') doCheckView();
    else if (act === 'lock') void doLock(false);
    else if (act === 'preview-timer') {
      const secs = room?.settings.hidingTimeSec ?? 60;
      deadlineMs = Date.now() + secs * 1000;
      frozenNoticed = false;
      noticeLine.textContent = `Preview timer started (${secs}s + ${HIDER_OVERTIME_SEC}s overtime).`;
      render();
    }
  });

  socket.on('room:state', (payload: { room: ClientRoom }) => {
    if (payload.room.code === code()) {
      room = payload.room;
      render();
    }
  });
  socket.on('hiding:started', (payload: { roomCode: string; deadlineMs: number }) => {
    if (payload.roomCode !== code()) return;
    el.hidden = false;
    locked = false;
    skipped = false;
    panoId = null;
    frozenNoticed = false;
    spyFeed = '';
    clearProbes();
    deadlineMs = payload.deadlineMs;
    void ensureMap();
    render();
  });
  socket.on('hide:locked', (payload: { roomCode: string; pins: Array<{ lat: number; lng: number }> }) => {
    if (payload.roomCode !== code()) return;
    renderTeamPins(payload.pins);
  });
  socket.on('seeking:started', (payload: { roomCode: string }) => {
    if (payload.roomCode !== code() || previewMode) return;
    if (amSeeker()) {
      el.hidden = true;
      return;
    }
    // Hiders keep this view as the live situation room.
    el.hidden = false;
    spyFeed = 'Seeking is live — watch the seeker.';
    render();
  });
  socket.on('seeker:viewing', (payload: { roomCode: string; targetHiderId: string }) => {
    if (payload.roomCode !== code()) return;
    spyFeed =
      payload.targetHiderId === myId()
        ? 'ALERT: the seeker is viewing YOUR hide right now!'
        : `Seeker is viewing ${nameOf(payload.targetHiderId)}.`;
    render();
  });
  socket.on(
    'seeker:guessing',
    (payload: { roomCode: string; targetHiderId: string; region: { lat: number; lng: number } }) => {
      if (payload.roomCode !== code()) return;
      upsertProbe(payload.targetHiderId, payload.region);
      spyFeed =
        `Seeker probing near ${payload.region.lat}, ${payload.region.lng} ` +
        `for ${nameOf(payload.targetHiderId)}.`;
      render();
    },
  );
  socket.on('guess:locked', (payload: { roomCode: string; guess: Guess; tier: string }) => {
    if (payload.roomCode !== code()) return;
    const g = payload.guess;
    probes.get(g.targetHiderId)?.setMap(null);
    probes.delete(g.targetHiderId);
    spyFeed =
      `Seeker locked ${payload.tier} on ${nameOf(g.targetHiderId)}: ` +
      `+${g.points} pts (${g.distanceKm.toFixed(2)} km).`;
    render();
  });
  socket.on('round:ended', (payload: { roomCode: string }) => {
    if (payload.roomCode !== code() || previewMode) return;
    el.hidden = true;
    spyFeed = '';
    clearProbes();
  });

  setInterval(tick, 500);
  if (previewMode) void ensureMap();
  // Rebind this tab's seat after reload/reconnect; then refresh.
  void ensureSession(socket).then((r) => {
    if (r.session && !r.restored) {
      errorLine.textContent = 'Session not restored — rejoin from the lobby if hiding stops working.';
    }
    render();
  });
  socket.on('reconnect', () => {
    void ensureSession(socket).then(() => render());
  });
  render();
  return el;
}
