import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import { fromBase64, toBase64 } from 'lib0/buffer';
import * as Y from 'yjs';
import type { RawData } from 'ws';
import { SnapshotSchedulerService } from '../persistence/snapshot-scheduler.service';
import {
  ConnectionRegistryService,
  LatticeSocket,
} from './connection-registry.service';
import { DocRegistryService } from './doc-registry.service';
import { ClientMessage, ServerMessage } from './protocol';
import { RedisFanoutService, UpdateEnvelope } from './redis-fanout.service';

/**
 * The real-time sync gateway: raw `ws` per ADR-0002, wired to Yjs, fanned out across
 * server instances via Redis (SCRUM-29), snapshotted to Postgres (SCRUM-30).
 *
 * Deliberately does NOT use Nest's `@SubscribeMessage` decorator dispatch. That
 * mechanism (see `WsAdapter.bindMessageHandler` in `@nestjs/platform-ws`) requires
 * every incoming message to be shaped as `{ event, data }`, which would force a
 * different wire format than the flat `{ type, ... }` envelope DESIGN.md §4.2 already
 * establishes. Instead, `handleConnection` attaches a manual `message` listener and
 * dispatches on `type` itself.
 *
 * Broadcasting a client's update — even to other clients on this SAME instance —
 * always goes through Redis (`handleUpdate` publishes; `handleRemoteUpdate` is what
 * actually sends to local sockets), rather than a separate direct-broadcast path.
 * This isn't an accident: per DESIGN.md §6's architecture flow, "any op broadcast by
 * any instance... is published to Redis → all subscribed instances receive it and
 * forward to their locally connected clients" — there is one fan-out path, used
 * uniformly, not two. It also means an instance normally receives its own publishes
 * back through its own subscription whenever it has local clients on that doc; that's
 * expected, and `handleRemoteUpdate` skips re-sending to the originating client by
 * `clientId`, not by "was this instance the publisher."
 *
 * `handleJoin` subscribes to Redis *before* reading the doc's current state for the
 * `joined` response, not after — subscribing first guarantees no update can land in
 * the gap between "read the snapshot" and "start receiving live updates." Redis
 * SUBSCRIBE is acknowledged synchronously from the client's perspective (the awaited
 * promise resolves only once the subscription is active), so once `subscribe()`
 * resolves, every update published from that instant on is guaranteed to arrive via
 * `handleRemoteUpdate`, with zero overlap-or-gap against the snapshot already read.
 *
 * `handleRemoteUpdate` also schedules a snapshot write on every update, not
 * `handleUpdate` — it's the one place every update flows through regardless of origin
 * (locally-originated updates come back through it too, via the instance's own
 * subscription), so scheduling there covers all cases with one call site.
 *
 * Ticket: SCRUM-30 (LAT-E1B)
 */
@WebSocketGateway({ path: '/sync' })
export class SyncGateway
  implements
    OnGatewayConnection<LatticeSocket>,
    OnGatewayDisconnect<LatticeSocket>
{
  private readonly logger = new Logger(SyncGateway.name);

  constructor(
    private readonly docs: DocRegistryService,
    private readonly connections: ConnectionRegistryService,
    private readonly fanout: RedisFanoutService,
    private readonly snapshotScheduler: SnapshotSchedulerService,
  ) {}

  handleConnection(client: LatticeSocket): void {
    client.clientId = randomUUID();
    client.on('message', (raw: RawData) => {
      this.handleMessage(client, raw);
    });
  }

  handleDisconnect(client: LatticeSocket): void {
    if (!client.docId) return;
    const isEmpty = this.connections.remove(client.docId, client);
    if (isEmpty) {
      this.fanout
        .unsubscribe(client.docId)
        .catch((err: unknown) => this.logger.error(err));
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
        this.handleJoin(client, message.docId).catch((err: unknown) =>
          this.handleFailure(client, err),
        );
        return;
      case 'sync-request':
        this.handleSyncRequest(
          client,
          message.docId,
          message.stateVector,
        ).catch((err: unknown) => this.handleFailure(client, err));
        return;
      case 'update':
        this.handleUpdate(client, message.docId, message.update).catch(
          (err: unknown) => this.handleFailure(client, err),
        );
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
  private async handleJoin(
    client: LatticeSocket,
    docId: string,
  ): Promise<void> {
    client.docId = docId;
    const isFirstLocalClient = this.connections.add(docId, client);
    if (isFirstLocalClient) {
      await this.fanout.subscribe(docId, (envelope) =>
        this.handleRemoteUpdate(docId, envelope),
      );
    }

    const doc = await this.docs.getOrCreate(docId);
    this.send(client, {
      type: 'joined',
      docId,
      initialState: toBase64(Y.encodeStateAsUpdate(doc)),
    });
  }

  /** Computes and returns exactly what the client is missing, per its state vector. */
  private async handleSyncRequest(
    client: LatticeSocket,
    docId: string,
    stateVectorB64: string,
  ): Promise<void> {
    const doc = await this.docs.getOrCreate(docId);
    const missing = Y.encodeStateAsUpdate(doc, fromBase64(stateVectorB64));
    this.send(client, {
      type: 'sync-response',
      docId,
      update: toBase64(missing),
    });
  }

  /** Applies a client's update to the authoritative doc, then publishes it for fan-out. */
  private async handleUpdate(
    client: LatticeSocket,
    docId: string,
    updateB64: string,
  ): Promise<void> {
    const doc = await this.docs.getOrCreate(docId);
    Y.applyUpdate(doc, fromBase64(updateB64));
    await this.fanout.publish(docId, {
      fromClientId: client.clientId,
      update: updateB64,
    });
  }

  /** Fired for every update on `docId`'s Redis channel — including ones this instance just published. */
  private async handleRemoteUpdate(
    docId: string,
    envelope: UpdateEnvelope,
  ): Promise<void> {
    const doc = await this.docs.getOrCreate(docId);
    // Idempotent: a no-op if this instance already applied it locally in handleUpdate.
    Y.applyUpdate(doc, fromBase64(envelope.update));
    this.snapshotScheduler.schedule(docId, doc);

    for (const socket of this.connections.getSockets(docId)) {
      if (socket.clientId === envelope.fromClientId) continue;
      this.send(socket, {
        type: 'update',
        docId,
        update: envelope.update,
        fromClientId: envelope.fromClientId,
      });
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

  /**
   * A handler throwing (bad docId, DB error, etc.) used to be silent from the
   * client's perspective — logged server-side only, nothing sent back, so a failure
   * just looked like nothing happening. Surfacing it as an `error` message too, not
   * just logging it, so it's at least visible in the browser console instead of
   * indistinguishable from "no update was ever sent."
   */
  private handleFailure(client: LatticeSocket, err: unknown): void {
    this.logger.error(err);
    this.send(client, {
      type: 'error',
      code: 'internal-error',
      message: err instanceof Error ? err.message : 'Unexpected server error',
    });
  }
}
