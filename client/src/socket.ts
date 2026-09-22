import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;

/** Shared socket, same-origin (Vite dev proxy forwards /socket.io to :3001). */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({ autoConnect: true });
  }
  if (!socket.connected) socket.connect();
  return socket;
}
