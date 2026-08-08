import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import { fromBase64, toBase64 } from 'lib0/buffer';
import * as Y from 'yjs';
import type { RawData, WebSocket } from 'ws';
import { DocRegistryService } from './doc-registry.service';
import { ClientMessage, ServerMessage } from './protocol';

/**
 * A connected client's raw `ws` socket, tagged with the bits of state this gateway
 * needs to track per-connection: a server-issued id (used to skip echoing a client's
 * own update back to itself) and which doc it has joined, if any.
 */
interface LatticeSocket extends WebSocket {
  clientId: string;
  docId?: string;
}

/**
 * The real-time sync gateway: raw `ws` per ADR-0002, wired to Yjs.
 *
 * Deliberately does NOT use Nest's `@SubscribeMessage` decorator dispatch. That
 * mechanism (see `WsAdapter.bindMessageHandler` in `@nestjs/platform-ws`) requires
 * every incoming message to be shaped as `{ event, data }`, which would force a
 * different wire format than the flat `{ type, ... }` envelope DESIGN.md §4.2 already
 * establishes. Instead, `handleConnection` attaches a manual `message` listener and
 * dispatches on `type` itself — one more piece of connection-lifecycle plumbing
 * hand-built rather than delegated, consistent with ADR-0002's stated goal. Nest's own
 * internal message dispatch still runs alongside this (harmlessly, since it can never
 * match our messages' shape) — see SCRUM-28's implementation notes for detail.
 *
 * Per-doc connection tracking (`docSockets`) is intentionally simple and in-process
 * only for this ticket. SCRUM-29 formalizes it into a proper registry and adds Redis
 * pub/sub so this works across more than one server instance.
 *
 * Ticket: SCRUM-28 (LAT-E1B)
 */
@WebSocketGateway({ path: '/sync' })
export class SyncGateway
  implements
    OnGatewayConnection<LatticeSocket>,
    OnGatewayDisconnect<LatticeSocket>
{
  private readonly logger = new Logger(SyncGateway.name);
  private readonly docSockets = new Map<string, Set<LatticeSocket>>();

  constructor(private readonly docs: DocRegistryService) {}

  handleConnection(client: LatticeSocket): void {
    client.clientId = randomUUID();
    client.on('message', (raw: RawData) => {
      this.handleMessage(client, raw);
    });
  }

  handleDisconnect(client: LatticeSocket): void {
    if (client.docId) {
      this.docSockets.get(client.docId)?.delete(client);
    }
  }

  private handleMessage(client: LatticeSocket, raw: RawData): void {
    // RawData is `Buffer | ArrayBuffer | Buffer[]` — the latter two show up for binary
    // or fragmented frames, neither of which this JSON-only protocol sends. Narrowing
    // explicitly (rather than calling `.toString()` on the union directly) avoids
    // silently stringifying an ArrayBuffer to the useless "[object ArrayBuffer]".
    if (!Buffer.isBuffer(raw)) {
      this.send(client, {
        type: 'error',
        code: 'unsupported-frame',
        message: 'Only text (JSON) frames are supported',
      });
      return;
    }

    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      this.send(client, {
        type: 'error',
        code: 'bad-json',
        message: 'Message was not valid JSON',
      });
      return;
    }

    switch (message.type) {
      case 'join':
        this.handleJoin(client, message.docId);
        return;
      case 'sync-request':
        this.handleSyncRequest(client, message.docId, message.stateVector);
        return;
      case 'update':
        this.handleUpdate(client, message.docId, message.update);
        return;
      default:
        this.send(client, {
          type: 'error',
          code: 'unknown-message-type',
          message: `Unrecognized message type: ${JSON.stringify(message)}`,
        });
    }
  }

  /** Subscribes the client to a doc's broadcast group and hands back its full current state. */
  private handleJoin(client: LatticeSocket, docId: string): void {
    client.docId = docId;
    let sockets = this.docSockets.get(docId);
    if (!sockets) {
      sockets = new Set();
      this.docSockets.set(docId, sockets);
    }
    sockets.add(client);

    const doc = this.docs.getOrCreate(docId);
    this.send(client, {
      type: 'joined',
      docId,
      initialState: toBase64(Y.encodeStateAsUpdate(doc)),
    });
  }

  /** Computes and returns exactly what the client is missing, per its state vector. */
  private handleSyncRequest(
    client: LatticeSocket,
    docId: string,
    stateVectorB64: string,
  ): void {
    const doc = this.docs.getOrCreate(docId);
    const missing = Y.encodeStateAsUpdate(doc, fromBase64(stateVectorB64));
    this.send(client, {
      type: 'sync-response',
      docId,
      update: toBase64(missing),
    });
  }

  /** Applies a client's update to the authoritative doc, then fans it out to peers. */
  private handleUpdate(
    client: LatticeSocket,
    docId: string,
    updateB64: string,
  ): void {
    const doc = this.docs.getOrCreate(docId);
    Y.applyUpdate(doc, fromBase64(updateB64));
    this.broadcast(docId, client, {
      type: 'update',
      docId,
      update: updateB64,
      fromClientId: client.clientId,
    });
  }

  /** Sends `message` to every other client subscribed to `docId` — never back to `origin`. */
  private broadcast(
    docId: string,
    origin: LatticeSocket,
    message: ServerMessage,
  ): void {
    const sockets = this.docSockets.get(docId);
    if (!sockets) return;
    for (const socket of sockets) {
      if (socket === origin) continue;
      this.send(socket, message);
    }
  }

  private send(client: LatticeSocket, message: ServerMessage): void {
    if (client.readyState !== client.OPEN) return;
    try {
      client.send(JSON.stringify(message));
    } catch (err) {
      this.logger.error(err);
    }
  }
}
