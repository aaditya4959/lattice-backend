import WebSocket from 'ws';
import { ClientMessage, ServerMessage } from '../../src/sync/protocol';

/**
 * Shared by every sync-related e2e spec — extracted here once six files had grown
 * near-identical copies of the same handful of functions (SCRUM-38).
 */

export function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once('open', () => resolve()));
}

const queues = new WeakMap<WebSocket, ServerMessage[]>();
const waiters = new WeakMap<WebSocket, ((message: ServerMessage) => void)[]>();

/**
 * Lazily attaches ONE persistent `message` listener per socket that queues every
 * incoming frame — set up on a socket's first `waitForMessage` call, not eagerly, so
 * ordinary call sites (`send(...)` immediately followed by `await waitForMessage(...)`)
 * don't change behavior.
 */
function ensureQueue(socket: WebSocket): void {
  if (queues.has(socket)) return;
  queues.set(socket, []);
  waiters.set(socket, []);
  socket.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString()) as ServerMessage;
    const pending = waiters.get(socket)!;
    const waiter = pending.shift();
    if (waiter) {
      waiter(message);
    } else {
      queues.get(socket)!.push(message);
    }
  });
}

/**
 * Returns the next message for `socket`, in arrival order — queued (not a bare
 * `.once('message')`), since SCRUM-46 the server can send more than one message in
 * immediate succession with no `await` between them (`joined` then `presence` on
 * join). A `.once`-per-call pattern loses whichever of a same-tick burst arrives
 * before the NEXT call registers its listener; queuing every arrival as it happens
 * and draining in FIFO order is correct for both that burst case and the original
 * one-message-per-response case this was written for.
 */
export function waitForMessage(socket: WebSocket): Promise<ServerMessage> {
  ensureQueue(socket);
  const queue = queues.get(socket)!;
  const queued = queue.shift();
  if (queued) return Promise.resolve(queued);

  return new Promise((resolve) => {
    waiters.get(socket)!.push(resolve);
  });
}

export function send(socket: WebSocket, message: ClientMessage): void {
  socket.send(JSON.stringify(message));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Asserts no message arrives on `socket` within `withinMs` — for proving a negative
 * (e.g. "a second tab joining doesn't trigger a fresh presence broadcast"), where
 * there's no positive message to await instead. The `waitForMessage` listener that
 * loses the race stays attached to the socket harmlessly; it either never fires (the
 * common case here) or resolves later into nothing anyone awaits, not a rejection.
 */
export async function expectNoMessage(
  socket: WebSocket,
  withinMs = 100,
): Promise<void> {
  const result = await Promise.race([
    waitForMessage(socket).then(() => 'message' as const),
    sleep(withinMs).then(() => 'timeout' as const),
  ]);
  expect(result).toBe('timeout');
}
