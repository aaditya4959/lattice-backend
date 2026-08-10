import WebSocket from 'ws';
import { ClientMessage, ServerMessage } from '../../src/sync/protocol';

/**
 * Shared by every sync-related e2e spec — extracted here once six files had grown
 * near-identical copies of the same handful of functions (SCRUM-38).
 */

export function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once('open', () => resolve()));
}

export function waitForMessage(socket: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve) => {
    socket.once('message', (data: Buffer) => {
      resolve(JSON.parse(data.toString()) as ServerMessage);
    });
  });
}

export function send(socket: WebSocket, message: ClientMessage): void {
  socket.send(JSON.stringify(message));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
