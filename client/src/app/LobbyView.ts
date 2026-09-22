import { getSocket } from '../socket';
import { loadSession, saveSession } from '../session';
import { MODE_INFO, regionsFor, type RegionPreset } from '../regions';
import type { ClientRoom, GameMode, MapScale, Player } from '../types';
import type { Socket } from 'socket.io-client';

interface AckRes {
  ok: boolean;
  room?: ClientRoom;
  player?: Player;
  error?: string;
  code?: string;
}

function emitAck(socket: Socket, ev: string, payload: unknown): Promise<AckRes> {
  return new Promise((resolve) => {
    socket.emit(ev, payload, (res: AckRes) => resolve(res));
  });
}

function num(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Lobby: entry (create/join) + room (code share, settings, seeker pick, teams). */
export function LobbyView(): HTMLElement {
  const socket = getSocket();
  const el = document.createElement('section');

  let room: ClientRoom | null = null;
  let myId: string | null = loadSession()?.playerId ?? null;
  let settingsDirty = false;

  el.innerHTML = `
    <div class="card" data-part="entry">
      <h2>Join or create a room</h2>
      <div class="row">
        <div class="field"><label>Display name</label><input data-f="name" maxlength="20" /></div>
        <div class="field"><label>Room code</label><input data-f="code" maxlength="6" style="text-transform:uppercase" /></div>
      </div>
      <div class="row" style="margin-top:12px">
        <button data-act="join">Join room</button>
        <button data-act="rejoin" class="secondary">Rejoin</button>
      </div>
      <h3>Create a room</h3>
      <div data-f="create-settings"></div>
      <div class="row" style="margin-top:12px">
        <button data-act="create">Create room</button>
      </div>
      <p class="error" data-f="entry-error"></p>
    </div>
    <div class="card" data-part="room" hidden>
      <div class="row">
        <div><div class="hint">Room code (share it)</div><div class="room-code" data-f="room-code"></div></div>
        <div class="field"><label>&nbsp;</label><div class="row">
          <button data-act="copy" class="secondary">Copy code</button>
          <button data-act="leave" class="secondary">Leave</button>
          <button data-act="close" class="secondary" data-f="close-btn" hidden>Close room</button>
        </div></div>
      </div>
      <p class="hint" data-f="share-hint"></p>
      <h3>Players</h3>
      <ul class="players" data-f="players"></ul>
      <h3>Seeker</h3>
      <div class="row">
        <span data-f="seeker-line" class="hint"></span>
        <button data-act="random-seeker" class="secondary" data-f="random-btn" hidden>Pick random seeker</button>
      </div>
      <h3 data-f="settings-title">Settings</h3>
      <div data-f="room-settings"></div>
      <div class="row" style="margin-top:12px">
        <button data-act="save" data-f="save-btn" hidden>Save settings</button>
        <button data-act="start" data-f="start-btn" hidden>Start round</button>
      </div>
      <p class="hint" data-f="mode-hint"></p>
      <p class="error" data-f="room-error"></p>
      <p class="notice" data-f="room-notice"></p>
    </div>`;

  const q = <T extends HTMLElement = HTMLElement>(sel: string): T => el.querySelector(sel) as T;
  const entry = q('[data-part="entry"]');
  const roomCard = q('[data-part="room"]');
  const nameInput = q<HTMLInputElement>('[data-f="name"]');
  const codeInput = q<HTMLInputElement>('[data-f="code"]');
  const entryError = q('[data-f="entry-error"]');
  const roomError = q('[data-f="room-error"]');
  const roomNotice = q('[data-f="room-notice"]');
  const playersUl = q('[data-f="players"]');
  const seekerLine = q('[data-f="seeker-line"]');
  const modeHint = q('[data-f="mode-hint"]');

  nameInput.value = loadSession()?.name ?? '';
  codeInput.value =
    new URLSearchParams(location.search).get('code') ?? loadSession()?.code ?? '';

  interface SettingsForm {
    element: HTMLElement;
    read: () => {
      mapScale: MapScale;
      regionId: string;
      hidingTimeSec: number;
      seekingTimeSec: number;
      bonusTimeSec: number;
      mode: GameMode;
    };
    write: (r: ClientRoom) => void;
    scaleSelect: HTMLSelectElement;
    regionSelect: HTMLSelectElement;
  }

  function makeSettingsForm(initial: ClientRoom | null): SettingsForm {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="row">
        <div class="field"><label>Map scale</label><select data-s="scale">
          <option value="WORLD">World</option>
          <option value="CONTINENT">Continent</option>
          <option value="COUNTRY">Country</option>
          <option value="CITY">City</option>
        </select></div>
        <div class="field"><label>Region (Street View verified)</label><select data-s="region"></select></div>
        <div class="field"><label>Mode</label><select data-s="mode">
          <option value="CLASSIC">Classic</option>
          <option value="1V1">1v1</option>
          <option value="TEAMS">Teams</option>
        </select></div>
      </div>
      <div class="row" style="margin-top:8px">
        <div class="field"><label>Hiding time (s)</label><input data-s="hide" type="number" min="10" max="3600" /></div>
        <div class="field"><label>Seeking time (s)</label><input data-s="seek" type="number" min="30" max="3600" /></div>
        <div class="field"><label>Bonus per find (s)</label><input data-s="bonus" type="number" min="0" max="600" /></div>
      </div>
      <p class="hint" data-s="modeinfo"></p>`;
    const qs = <T extends HTMLElement = HTMLElement>(s: string): T => wrap.querySelector(s) as T;
    const scaleSelect = qs<HTMLSelectElement>('[data-s="scale"]');
    const regionSelect = qs<HTMLSelectElement>('[data-s="region"]');
    const modeSelect = qs<HTMLSelectElement>('[data-s="mode"]');
    const hideInput = qs<HTMLInputElement>('[data-s="hide"]');
    const seekInput = qs<HTMLInputElement>('[data-s="seek"]');
    const bonusInput = qs<HTMLInputElement>('[data-s="bonus"]');
    const modeInfo = qs('[data-s="modeinfo"]');

    const seed = initial?.settings ?? {
      mapScale: 'WORLD' as MapScale,
      regionId: 'world',
      hidingTimeSec: 60,
      seekingTimeSec: 300,
      bonusTimeSec: 30,
      mode: 'CLASSIC' as GameMode,
    };

    function fillRegions(scale: MapScale, keep?: string) {
      const list: RegionPreset[] = regionsFor(scale);
      regionSelect.innerHTML = list.map((r) => `<option value="${r.id}">${r.label}</option>`).join('');
      if (keep && list.some((r) => r.id === keep)) regionSelect.value = keep;
    }

    function refreshModeInfo() {
      modeInfo.textContent = MODE_INFO[modeSelect.value] ?? '';
    }

    scaleSelect.value = seed.mapScale;
    fillRegions(seed.mapScale, seed.regionId);
    modeSelect.value = seed.mode;
    hideInput.value = String(seed.hidingTimeSec);
    seekInput.value = String(seed.seekingTimeSec);
    bonusInput.value = String(seed.bonusTimeSec);
    refreshModeInfo();

    scaleSelect.addEventListener('change', () => {
      fillRegions(scaleSelect.value as MapScale);
      settingsDirty = true;
    });
    wrap.addEventListener('input', () => {
      settingsDirty = true;
      refreshModeInfo();
    });

    return {
      element: wrap,
      scaleSelect,
      regionSelect,
      read: () => ({
        mapScale: scaleSelect.value as MapScale,
        regionId: regionSelect.value,
        hidingTimeSec: num(hideInput.value, 60),
        seekingTimeSec: num(seekInput.value, 300),
        bonusTimeSec: num(bonusInput.value, 30),
        mode: modeSelect.value as GameMode,
      }),
      write: (r: ClientRoom) => {
        scaleSelect.value = r.settings.mapScale;
        fillRegions(r.settings.mapScale, r.settings.regionId);
        modeSelect.value = r.settings.mode;
        hideInput.value = String(r.settings.hidingTimeSec);
        seekInput.value = String(r.settings.seekingTimeSec);
        bonusInput.value = String(r.settings.bonusTimeSec);
        refreshModeInfo();
      },
    };
  }

  const createForm = makeSettingsForm(null);
  q('[data-f="create-settings"]').appendChild(createForm.element);
  let roomForm: SettingsForm | null = null;

  const isOwner = () => !!room && !!myId && room.ownerId === myId;

  function showError(target: HTMLElement, res: AckRes) {
    target.textContent = res.code === 'NAME_TAKEN_REJOIN_AVAILABLE'
      ? `${res.error} — use Rejoin.`
      : (res.error ?? 'Something went wrong');
  }

  function setRoom(next: ClientRoom | null, player?: Player) {
    room = next;
    if (player && next) {
      myId = player.id;
      saveSession(next.code, player.id, player.name);
    }
    entry.hidden = !!next;
    roomCard.hidden = !next;
    settingsDirty = false;
    if (next) {
      q('[data-f="room-code"]').textContent = next.code;
      q('[data-f="share-hint"]').textContent =
        `Share: ${location.origin}${location.pathname}?code=${next.code}`;
      const holder = q('[data-f="room-settings"]');
      holder.innerHTML = '';
      roomForm = makeSettingsForm(next);
      roomForm.element
        .querySelectorAll('select, input')
        .forEach((n) => ((n as HTMLInputElement).disabled = !isOwner()));
      holder.appendChild(roomForm.element);
      q('[data-f="close-btn"]').hidden = !isOwner();
      q('[data-f="random-btn"]').hidden = !isOwner();
      q('[data-f="save-btn"]').hidden = !isOwner();
      q('[data-f="start-btn"]').hidden = !isOwner();
      renderRoom();
    }
  }

  function renderRoom() {
    const r = room;
    if (!r) return;
    const owner = isOwner();
    const roundActive = r.phase === 'HIDING' || r.phase === 'SEEKING';
    if (roomForm && !settingsDirty && owner) roomForm.write(r);
    if (roomForm) {
      roomForm.element
        .querySelectorAll('select, input')
        .forEach((n) => ((n as HTMLInputElement).disabled = !owner || roundActive));
    }
    q('[data-f="random-btn"]').hidden = !owner || roundActive;
    q('[data-f="save-btn"]').hidden = !owner || roundActive;
    q('[data-f="start-btn"]').hidden = !owner || roundActive;
    playersUl.innerHTML = '';
    for (const p of r.players) {
      const li = document.createElement('li');
      const tags = [
        p.id === r.ownerId ? '<span class="badge">owner</span>' : '',
        r.settings.seekerId === p.id ? '<span class="badge seeker">seeker</span>' : '',
        p.team ? `<span class="badge">team ${escapeHtml(p.team)}</span>` : '',
        p.connected ? '' : '<span class="badge offline">offline</span>',
      ].join('');
      li.innerHTML = `<strong>${escapeHtml(p.name)}</strong> ${tags} <span class="hint">${p.score} pts</span>`;
      if (owner && !roundActive && p.id !== r.settings.seekerId && p.connected) {
        const btn = document.createElement('button');
        btn.className = 'secondary';
        btn.textContent = 'Make seeker';
        btn.addEventListener('click', () => void doPickSeeker(p.id));
        li.appendChild(btn);
      }
      if (owner && !roundActive) {
        const teamInput = document.createElement('input');
        teamInput.placeholder = 'Team';
        teamInput.maxLength = 12;
        teamInput.value = p.team ?? '';
        teamInput.style.maxWidth = '110px';
        teamInput.setAttribute('aria-label', `Team for ${p.name}`);
        teamInput.addEventListener('change', () => void doAssignTeam(p.id, teamInput.value));
        li.appendChild(teamInput);
      }
      playersUl.appendChild(li);
    }
    const seeker = r.players.find((p) => p.id === r.settings.seekerId);
    seekerLine.textContent = seeker ? `Seeker: ${seeker.name}` : 'No seeker picked yet.';
    modeHint.textContent =
      r.phase === 'HIDING' || r.phase === 'SEEKING'
        ? `Round ${r.roundNo} running — ${r.phase === 'HIDING' ? 'hiders are hiding.' : 'seeker is seeking.'}`
        : lobbyWarnings(r);
  }

  function lobbyWarnings(r: ClientRoom): string {
    const n = r.playerCount;
    if (r.settings.mode === '1V1' && n !== 2) return '1v1 needs exactly 2 players to start.';
    if (r.settings.mode === 'CLASSIC' && n < 3) return 'Classic needs at least 3 players (1 seeker + 2 hiders).';
    if (r.settings.mode === 'TEAMS') {
      const teams = new Set(r.players.map((p) => (p.team ?? '').trim()).filter(Boolean));
      if (teams.size < 2) return 'Teams mode needs at least 2 teams — owner assigns them above.';
    }
    if (!r.settings.seekerId) return 'Pick a seeker (random or owner pick) before starting.';
    return '';
  }

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  }

  async function doCreate() {
    entryError.textContent = '';
    const name = nameInput.value.trim();
    const res = await emitAck(socket, 'createRoom', { name, settings: createForm.read() });
    if (!res.ok || !res.room || !res.player) return showError(entryError, res);
    setRoom(res.room, res.player);
  }

  async function doJoin() {
    entryError.textContent = '';
    const res = await emitAck(socket, 'joinRoom', { code: codeInput.value, name: nameInput.value });
    if (!res.ok || !res.room || !res.player) return showError(entryError, res);
    setRoom(res.room, res.player);
  }

  async function doRejoin() {
    entryError.textContent = '';
    if (!socket.connected) socket.connect();
    const res = await emitAck(socket, 'rejoin', { code: codeInput.value, name: nameInput.value });
    if (!res.ok || !res.room || !res.player) return showError(entryError, res);
    setRoom(res.room, res.player);
  }

  async function doSave() {
    if (!room || !roomForm) return;
    roomError.textContent = '';
    roomNotice.textContent = '';
    const res = await emitAck(socket, 'updateSettings', { code: room.code, settings: roomForm.read() });
    if (!res.ok || !res.room) return showError(roomError, res);
    settingsDirty = false;
    setRoomKeepForm(res.room);
    roomNotice.textContent = 'Settings saved.';
  }

  /** Update state without rebuilding the owner's (possibly edited) settings form. */
  function setRoomKeepForm(next: ClientRoom) {
    room = next;
    renderRoom();
  }

  async function doPickSeeker(playerId?: string) {
    if (!room) return;
    roomError.textContent = '';
    const res = await emitAck(socket, 'pickSeeker', playerId ? { code: room.code, playerId } : { code: room.code, mode: 'random' });
    if (!res.ok || !res.room) return showError(roomError, res);
    setRoomKeepForm(res.room);
  }

  async function doAssignTeam(playerId: string, team: string) {
    if (!room) return;
    roomError.textContent = '';
    const res = await emitAck(socket, 'assignTeam', { code: room.code, playerId, team });
    if (!res.ok || !res.room) return showError(roomError, res);
    setRoomKeepForm(res.room);
  }

  async function doStart() {
    if (!room) return;
    roomError.textContent = '';
    roomNotice.textContent = '';
    const res = await emitAck(socket, 'startRound', { code: room.code });
    if (!res.ok || !res.room) {
      roomNotice.textContent = res.error ?? 'Could not start round';
      return;
    }
    setRoomKeepForm(res.room);
    roomNotice.textContent = 'Round started — hiding phase is live.';
  }

  async function doClose() {
    if (!room) return;
    const res = await emitAck(socket, 'closeRoom', { code: room.code });
    if (!res.ok) return showError(roomError, res);
    setRoom(null);
  }

  function doLeave() {
    socket.disconnect();
    setRoom(null);
  }

  function doCopy() {
    if (!room) return;
    const code = room.code;
    const done = () => (roomNotice.textContent = 'Code copied.');
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(code).then(done, () => (roomNotice.textContent = code));
    else roomNotice.textContent = code;
  }

  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'create') void doCreate();
    else if (act === 'join') void doJoin();
    else if (act === 'rejoin') void doRejoin();
    else if (act === 'save') void doSave();
    else if (act === 'random-seeker') void doPickSeeker();
    else if (act === 'start') void doStart();
    else if (act === 'close') void doClose();
    else if (act === 'leave') doLeave();
    else if (act === 'copy') doCopy();
  });

  socket.on('room:state', (payload: { room: ClientRoom }) => {
    if (room && payload.room.code === room.code) setRoomKeepForm(payload.room);
  });
  socket.on('seeker:assigned', (payload: { room: ClientRoom }) => {
    if (room && payload.room.code === room.code) {
      setRoomKeepForm(payload.room);
      roomNotice.textContent = 'Seeker assigned.';
    }
  });
  socket.on('player:joined', (payload: { room: ClientRoom }) => {
    if (room && payload.room.code === room.code) setRoomKeepForm(payload.room);
  });
  socket.on('player:rejoined', (payload: { room: ClientRoom }) => {
    if (room && payload.room.code === room.code) setRoomKeepForm(payload.room);
  });
  socket.on('player:disconnected', (payload: { room: ClientRoom; player: Player; wasSeeker: boolean }) => {
    if (room && payload.room.code === room.code) {
      setRoomKeepForm(payload.room);
      roomNotice.textContent = payload.wasSeeker
        ? `${payload.player.name} (seeker) disconnected — 30s grace.`
        : `${payload.player.name} disconnected — seat kept for rejoin.`;
    }
  });
  socket.on('seeker:grace-started', () => {
    roomNotice.textContent = 'Seeker disconnected — 30s grace before the round ends as-is.';
  });
  socket.on('seeker:grace-cancelled', () => {
    roomNotice.textContent = 'Seeker rejoined — grace cancelled.';
  });
  socket.on('room:closed', () => {
    setRoom(null);
    entryError.textContent = 'Room was closed by the owner.';
  });
  socket.on('reconnect', () => {
    // Transport drop loses the server-side socket binding — rejoin this tab's seat.
    const s = loadSession();
    if (room && s && s.name) {
      void emitAck(socket, 'rejoin', { code: s.code, name: s.name }).then((res) => {
        if (res?.ok && res.room) setRoomKeepForm(res.room);
      });
    }
  });

  return el;
}
