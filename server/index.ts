import dotenv from 'dotenv';
// Local server/.env wins; the monorepo-root .env fills the rest.
dotenv.config();
dotenv.config({ path: '../.env' });
import express from 'express';
import { createServer } from 'http';
import { Server, type Socket } from 'socket.io';
import cors from 'cors';
import {
  SEEKER_GRACE_SEC,
  RoomError,
  assignTeam,
  closeRoom,
  createRoom,
  findPlayerByName,
  getRoom,
  joinRoom,
  markDisconnected,
  pickSeeker,
  rejoinRoom,
  anonymizedPins,
  getHideForSeeker,
  setGuess,
  setHide,
  toClientRoom,
  updateSettings,
  type ClientRoom,
  type Player,
  type Room,
  type RoomSettings,
  type SeekerSelection,
} from './rooms.js';
import {
  addBonusTime,
  endRound,
  maybeEndSeeking,
  maybeStartSeeking,
  onHidingEnded,
  onSeekingEnded,
  startRound,
  type RoundEvents,
} from './game.js';

const PORT = Number(process.env.PORT ?? 3001);
// Overridable for tests (spec default: 30s).
export const SEEKER_GRACE_MS = Number(process.env.SEEKER_GRACE_MS ?? SEEKER_GRACE_SEC * 1000);

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'geohidenseek-server' });
});

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

interface SocketCtx {
  roomCode?: string;
  playerId?: string;
}

type Ack = (res: Record<string, unknown>) => void;

const seekerGraceTimers = new Map<string, NodeJS.Timeout>();
/** Active round clocks (hiding → seeking → end). */
const roundTimers = new Map<string, NodeJS.Timeout>();

const roundEvents: RoundEvents = {
  broadcast: (code, event, payload) => {
    io.to(code).emit(event, payload);
  },
};

function clearRoundTimer(code: string) {
  const t = roundTimers.get(code);
  if (t) {
    clearTimeout(t);
    roundTimers.delete(code);
  }
}

/** Schedule the hiding clock; chains into the seeking clock on expiry. */
function scheduleHidingClock(code: string, delayMs: number) {
  clearRoundTimer(code);
  roundTimers.set(
    code,
    setTimeout(() => {
      const res = onHidingEnded(code, roundEvents);
      if (res) scheduleSeekingClock(code, Math.max(0, (res.room.seekingEndsAtMs ?? Date.now()) - Date.now()));
    }, Math.max(0, delayMs)),
  );
}

function scheduleSeekingClock(code: string, delayMs: number) {
  clearRoundTimer(code);
  roundTimers.set(
    code,
    setTimeout(() => {
      roundTimers.delete(code);
      onSeekingEnded(code, roundEvents, 'timeout');
    }, Math.max(0, delayMs)),
  );
}

function errPayload(e: unknown) {
  if (e instanceof RoomError) return { ok: false, error: e.message, code: e.code };
  return { ok: false, error: e instanceof Error ? e.message : 'Unknown error', code: 'UNKNOWN' };
}

function broadcastRoomState(code: string) {
  const room = getRoom(code);
  if (room) io.to(code).emit('room:state', { room: toClientRoom(room) });
}

function clearSeekerGrace(code: string) {
  const t = seekerGraceTimers.get(code);
  if (t) {
    clearTimeout(t);
    seekerGraceTimers.delete(code);
  }
}

/** Start the 30s seeker-disconnect grace. On expiry an active round ends scored as-is. */
function startSeekerGrace(code: string, seeker: Player) {
  clearSeekerGrace(code);
  io.to(code).emit('seeker:grace-started', {
    roomCode: code,
    playerId: seeker.id,
    graceSec: Math.round(SEEKER_GRACE_MS / 1000),
  });
  const timer = setTimeout(() => {
    seekerGraceTimers.delete(code);
    const room = getRoom(code);
    if (!room) return;
    const current = room.players.get(seeker.id);
    // Seeker rejoined in time → nothing to do.
    if (!current || current.connected) return;
    // v1: score the round as-is. Full scoring lands with game.ts; for now
    // broadcast expiry so clients + future endRound logic can settle.
    io.to(code).emit('seeker:grace-expired', { roomCode: code, playerId: seeker.id });
    if (room.phase === 'HIDING' || room.phase === 'SEEKING') {
      // Score the round as-is per spec.
      clearRoundTimer(code);
      endRound(code, roundEvents, 'seeker-timeout');
    } else {
      broadcastRoomState(code);
    }
  }, SEEKER_GRACE_MS);
  seekerGraceTimers.set(code, timer);
}

function attachSession(socket: Socket, code: string, playerId: string) {
  (socket.data as SocketCtx).roomCode = code;
  (socket.data as SocketCtx).playerId = playerId;
  playerSocket.set(playerId, socket.id);
  socket.join(code);
}

/** Which live socket currently holds each seat (playerId → socket.id). */
const playerSocket = new Map<string, string>();

io.on('connection', (socket) => {
  socket.emit('hello', { id: socket.id });

  socket.on('createRoom', (payload: { name: string; settings: RoomSettings }, ack?: Ack) => {
    try {
      const { room, player } = createRoom(payload?.name, payload?.settings);
      attachSession(socket, room.code, player.id);
      const roomDto: ClientRoom = toClientRoom(room);
      ack?.({ ok: true, room: roomDto, player });
      // Send state to the creator directly too (they just joined the socket room).
      socket.emit('room:state', { room: roomDto });
    } catch (e) {
      ack?.(errPayload(e));
    }
  });

  socket.on('joinRoom', (payload: { code: string; name: string }, ack?: Ack) => {
    try {
      const { room, player } = joinRoom(payload?.code, payload?.name);
      attachSession(socket, room.code, player.id);
      const roomDto = toClientRoom(room);
      ack?.({ ok: true, room: roomDto, player });
      socket.to(room.code).emit('player:joined', { room: roomDto, player });
      broadcastRoomState(room.code);
    } catch (e) {
      ack?.(errPayload(e));
    }
  });

  socket.on('rejoin', (payload: { code: string; name: string }, ack?: Ack) => {
    try {
      const { room, player } = rejoinRoom(payload?.code, payload?.name);
      completeRejoin(socket, room, player, ack);
    } catch (e) {
      // Ghost seat: the name is flagged connected but its socket is gone
      // (phone sleep, network drop without a goodbye). Let this live
      // socket claim it; a genuinely-connected duplicate stays rejected.
      if (e instanceof RoomError && e.code === 'ALREADY_CONNECTED') {
        const room = getRoom(payload?.code);
        const existing = room && findPlayerByName(room, payload?.name ?? '');
        const holder = existing && playerSocket.get(existing.id);
        if (room && existing && (!holder || !io.sockets.sockets.has(holder))) {
          existing.connected = true;
          completeRejoin(socket, room, existing, ack);
          return;
        }
      }
      ack?.(errPayload(e));
    }
  });

  function completeRejoin(socket: Socket, room: Room, player: Player, ack?: Ack) {
    attachSession(socket, room.code, player.id);
    // Seeker came back within grace → cancel the timeout.
    if (room.settings.seekerId === player.id && seekerGraceTimers.has(room.code)) {
      clearSeekerGrace(room.code);
      io.to(room.code).emit('seeker:grace-cancelled', { roomCode: room.code, playerId: player.id });
    }
    const roomDto = toClientRoom(room);
    ack?.({ ok: true, room: roomDto, player });
    socket.to(room.code).emit('player:rejoined', { room: roomDto, player });
    broadcastRoomState(room.code);
  }

  // Owner closes the room; everyone is notified. (Full owner-auth lands with lobby UI.)
  socket.on('closeRoom', (payload: { code: string }, ack?: Ack) => {
    try {
      const room = getRoom(payload?.code);
      if (!room) throw new RoomError('ROOM_NOT_FOUND', 'Room not found');
      const ctx = socket.data as SocketCtx;
      if (ctx.playerId !== room.ownerId) throw new RoomError('NOT_OWNER', 'Only the owner can close the room');
      clearSeekerGrace(room.code);
      clearRoundTimer(room.code);
      for (const pid of room.players.keys()) playerSocket.delete(pid);
      closeRoom(room.code);
      io.to(room.code).emit('room:closed', { roomCode: room.code });
      io.in(room.code).socketsLeave(room.code);
      ack?.({ ok: true });
    } catch (e) {
      ack?.(errPayload(e));
    }
  });

  // Lobby ops (owner-only): settings, seeker pick, team assign.
  socket.on(
    'updateSettings',
    (payload: { code: string; settings: Partial<RoomSettings> }, ack?: Ack) => {
      try {
        const ctx = socket.data as SocketCtx;
        const { room } = updateSettings(payload?.code, ctx.playerId, payload?.settings ?? {});
        const roomDto = toClientRoom(room);
        ack?.({ ok: true, room: roomDto });
        broadcastRoomState(room.code);
      } catch (e) {
        ack?.(errPayload(e));
      }
    },
  );

  socket.on('pickSeeker', (payload: { code: string } & SeekerSelection, ack?: Ack) => {
    try {
      const ctx = socket.data as SocketCtx;
      const sel: SeekerSelection =
        payload && 'playerId' in payload && typeof payload.playerId === 'string'
          ? { playerId: payload.playerId }
          : { mode: 'random' };
      const { room, seeker } = pickSeeker(payload?.code, ctx.playerId, sel);
      const roomDto = toClientRoom(room);
      ack?.({ ok: true, room: roomDto, seeker });
      io.to(room.code).emit('seeker:assigned', { room: roomDto, seeker });
      broadcastRoomState(room.code);
    } catch (e) {
      ack?.(errPayload(e));
    }
  });

  socket.on(
    'assignTeam',
    (payload: { code: string; playerId: string; team: string }, ack?: Ack) => {
      try {
        const ctx = socket.data as SocketCtx;
        const { room, player } = assignTeam(payload?.code, ctx.playerId, payload?.playerId, payload?.team ?? '');
        const roomDto = toClientRoom(room);
        ack?.({ ok: true, room: roomDto, player });
        broadcastRoomState(room.code);
      } catch (e) {
        ack?.(errPayload(e));
      }
    },
  );

  // Round flow: owner starts (LOBBY/RESULTS → HIDING); clocks chain hiding → seeking → scored.
  socket.on('startRound', (payload: { code: string }, ack?: Ack) => {
    try {
      const ctx = socket.data as SocketCtx;
      const { room, hidingInMs } = startRound(payload?.code, ctx.playerId, roundEvents);
      clearSeekerGrace(room.code);
      scheduleHidingClock(room.code, hidingInMs);
      ack?.({ ok: true, room: toClientRoom(room) });
    } catch (e) {
      ack?.(errPayload(e));
    }
  });

  // Round flow: owner ends the active round early (auto-end covers timeouts).
  socket.on('endRound', (payload: { code: string }, ack?: Ack) => {
    try {
      const ctx = socket.data as SocketCtx;
      const room = getRoom(payload?.code);
      if (!room) throw new RoomError('ROOM_NOT_FOUND', 'Room not found');
      if (!ctx.playerId || ctx.playerId !== room.ownerId) {
        throw new RoomError('NOT_OWNER', 'Only the room owner can end a round');
      }
      clearRoundTimer(room.code);
      const { results } = endRound(room.code, roundEvents, 'owner-ended');
      ack?.({ ok: true, results, room: toClientRoom(room) });
    } catch (e) {
      ack?.(errPayload(e));
    }
  });

  // Hiding: lock a Street View hide (panoId required). Phase gating lands with the round flow.
  socket.on(
    'lockHide',
    (payload: { code: string; lat: number; lng: number; panoId: string }, ack?: Ack) => {
      try {
        const ctx = socket.data as SocketCtx;
        if (!ctx.playerId) throw new RoomError('NOT_IN_ROOM', 'Join a room first');
        const { room, hide } = setHide(
          payload?.code,
          ctx.playerId,
          Number(payload?.lat),
          Number(payload?.lng),
          payload?.panoId,
        );
        ack?.({ ok: true, hide, room: toClientRoom(room) });
        io.to(room.code).emit('hide:locked', {
          roomCode: room.code,
          pins: anonymizedPins(room),
          count: room.hides.size,
        });
        // All hiders locked → seeking starts now, timer or not.
        const started = maybeStartSeeking(room.code, roundEvents);
        if (started) {
          scheduleSeekingClock(
            room.code,
            Math.max(0, (started.room.seekingEndsAtMs ?? Date.now()) - Date.now()),
          );
        }
        broadcastRoomState(room.code);
      } catch (e) {
        ack?.(errPayload(e));
      }
    },
  );

  // Seeking: open a hider's panorama (seeker-only; broadcasts spectate info to hiders).
  socket.on('viewHide', (payload: { code: string; targetHiderId: string }, ack?: Ack) => {
    try {
      const ctx = socket.data as SocketCtx;
      const { room, target, panoId } = getHideForSeeker(payload?.code, ctx.playerId, payload?.targetHiderId);
      ack?.({ ok: true, panoId, targetHiderId: target.id });
      io.to(room.code).emit('seeker:viewing', {
        roomCode: room.code,
        seekerId: ctx.playerId,
        targetHiderId: target.id,
      });
    } catch (e) {
      ack?.(errPayload(e));
    }
  });

  // Seeking: live guess-pin preview (coarse region broadcast for hider spectate mode).
  socket.on(
    'previewGuess',
    (payload: { code: string; targetHiderId: string; lat: number; lng: number }, ack?: Ack) => {
      try {
        const ctx = socket.data as SocketCtx;
        const room = getRoom(payload?.code);
        if (!room) throw new RoomError('ROOM_NOT_FOUND', 'Room not found');
        if (room.settings.seekerId !== ctx.playerId) throw new RoomError('NOT_SEEKER', 'Only the seeker can do this');
        const target = room.players.get(payload?.targetHiderId);
        if (!target) throw new RoomError('NOT_IN_ROOM', 'Target hider not in room');
        const lat = Number(payload?.lat);
        const lng = Number(payload?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new RoomError('INVALID_PIN', 'Invalid guess pin');
        const round3 = (n: number) => Math.round(n * 1000) / 1000;
        socket.to(room.code).emit('seeker:guessing', {
          roomCode: room.code,
          seekerId: ctx.playerId,
          targetHiderId: target.id,
          region: { lat: round3(lat), lng: round3(lng) },
        });
        ack?.({ ok: true });
      } catch (e) {
        ack?.(errPayload(e));
      }
    },
  );

  // Seeking: lock a guess (distance + tier/points scored server-side).
  socket.on(
    'lockGuess',
    (payload: { code: string; targetHiderId: string; lat: number; lng: number }, ack?: Ack) => {
      try {
        const ctx = socket.data as SocketCtx;
        const { room, guess, tier } = setGuess(
          payload?.code,
          ctx.playerId,
          payload?.targetHiderId,
          Number(payload?.lat),
          Number(payload?.lng),
        );
        ack?.({ ok: true, guess, tier, room: toClientRoom(room) });
        io.to(room.code).emit('guess:locked', { roomCode: room.code, guess, tier });
        // All hides guessed → score now, timer or not (skips bonus on a finished round).
        const finished = maybeEndSeeking(room.code, roundEvents);
        if (finished) clearRoundTimer(room.code);
        else if (tier === 'FOUND') addBonusTime(room.code, roundEvents);
        broadcastRoomState(room.code);
      } catch (e) {
        ack?.(errPayload(e));
      }
    },
  );

  // All game events are implemented — no placeholders remain.

  socket.on('disconnect', () => {
    const ctx = socket.data as SocketCtx;
    if (!ctx.roomCode || !ctx.playerId) return;
    const room = getRoom(ctx.roomCode);
    if (!room) return;
    const stored = room.players.get(ctx.playerId);
    // Already rejoined elsewhere (or never joined) → ignore stale disconnect.
    if (!stored || !stored.connected) return;
    // A newer socket claimed this seat (takeover) → this goodbye is stale.
    if (playerSocket.get(ctx.playerId) !== socket.id) return;
    try {
      const { player, wasSeeker } = markDisconnected(room, ctx.playerId);
      socket.to(room.code).emit('player:disconnected', {
        room: toClientRoom(room),
        player,
        wasSeeker,
      });
      broadcastRoomState(room.code);
      if (wasSeeker) startSeekerGrace(room.code, player);
    } catch {
      // Room closed mid-disconnect — nothing to broadcast.
    }
  });
});

export { io, seekerGraceTimers };

httpServer.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
});
