import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import { fromBase64, toBase64 } from 'lib0/buffer';
import * as Y from 'yjs';
import type { RawData } from 'ws';
import { AuthTokenPayload } from '../auth/auth.service';
import { DocsService } from '../docs/docs.service';
import { SnapshotSchedulerService } from '../persistence/snapshot-scheduler.service';
import {
  ConnectionRegistryService,
  LatticeSocket,
} from './connection-registry.service';
import { CursorThrottleService } from './cursor-throttle.service';
import { DocRegistryService } from './doc-registry.service';
import { PresenceRegistryService } from './presence-registry.service';
import { ClientMessage, ServerMessage } from './protocol';
import {
  PresenceChannelEnvelope,
  RedisFanoutService,
  UpdateEnvelope,
} from './redis-fanout.service';

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
 * `join` also requires a valid JWT (SCRUM-38) — see handleJoin.
 *
 * Presence (SCRUM-46) tracks *users*, not sockets, in a separate
 * `PresenceRegistryService` — a user with two tabs open is one presence entry.
 * Cursor updates are throttled per connection via `CursorThrottleService` since
 * position changes far more often than document edits.
 *
 * Cross-instance presence/cursor fan-out (SCRUM-47) is a SEPARATE Redis channel per
 * doc (`presence:<id>`, via RedisFanoutService's `*Presence` methods) from the one
 * document updates use (`doc:<id>`), but the SAME philosophy: every instance applies
 * every envelope — including its own echoed back through its own subscription — and
 * independently decides whether to notify its own local clients
 * (handleRemotePresence). `join`/`left` additionally get a direct, immediate local
 * apply+broadcast in handleJoin/handleDisconnect (mirroring handleUpdate's direct
 * apply for document content) so the acting client's own siblings don't wait on a
 * Redis round trip; this is safe specifically because that direct call updates this
 * instance's PresenceRegistryService state BEFORE the echo arrives, so the echo's own
 * `isNewPresence`/`wasLastConnection` check correctly comes back false and skips a
 * duplicate broadcast — cursor has no such direct path (see handleCursor) since
 * cursor envelopes are unconditionally forwarded either way, so there's no staleness
 * risk to route around. A newly-subscribing instance also has no way to learn about
 * connections that predate its subscription (Redis pub/sub has no memory) — it
 * requests a `roll-call` on subscribe, and every already-subscribed instance
 * re-announces its own local users in response.
 *
 * Ticket: SCRUM-30 (LAT-E1B), SCRUM-38 (LAT-E2), SCRUM-46/SCRUM-47 (LAT-E5)
 */
@WebSocketGateway({ path: '/sync' })
export class SyncGateway
  implements
    OnGatewayConnection<LatticeSocket>,
    OnGatewayDisconnect<LatticeSocket>
{
  private readonly logger = new Logger(SyncGateway.name);

  constructor(
    private readonly docRegistry: DocRegistryService,
    private readonly docsAccess: DocsService,
    private readonly connections: ConnectionRegistryService,
    private readonly presence: PresenceRegistryService,
    private readonly cursorThrottle: CursorThrottleService,
    private readonly fanout: RedisFanoutService,
    private readonly snapshotScheduler: SnapshotSchedulerService,
    private readonly jwt: JwtService,
  ) {}

  handleConnection(client: LatticeSocket): void {
    client.clientId = randomUUID();
    client.on('message', (raw: RawData) => {
      this.handleMessage(client, raw);
    });
  }

  handleDisconnect(client: LatticeSocket): void {
    if (!client.docId) return;
    const docId = client.docId;
    const isEmpty = this.connections.remove(docId, client);
    if (isEmpty) {
      this.fanout
        .unsubscribe(docId)
        .catch((err: unknown) => this.logger.error(err));
      this.fanout
        .unsubscribePresence(docId)
        .catch((err: unknown) => this.logger.error(err));
    }

    if (client.userId) {
      const wasLastConnection = this.presence.remove(
        docId,
        client.userId,
        client.clientId,
      );
      if (wasLastConnection) {
        this.broadcastPresence(docId, client.clientId);
      }
      // Cross-instance fan-out: published unconditionally (not gated on
      // wasLastConnection) so every OTHER instance's own PresenceRegistryService — a
      // full replica, not a summary — correctly drops this exact clientId regardless
      // of whether it happened to be this user's last connection FROM THIS
      // INSTANCE'S local perspective specifically.
      this.fanout
        .publishPresence(docId, {
          kind: 'left',
          userId: client.userId,
          clientId: client.clientId,
        })
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
        this.handleJoin(client, message.docId, message.token).catch(
          (err: unknown) => this.handleFailure(client, err),
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
      case 'cursor':
        this.handleCursor(client, message.docId, message.position);
        return;
      default:
        this.send(client, {
          type: 'error',
          code: 'unknown-message-type',
          message: `Unrecognized message type: ${JSON.stringify(message)}`,
        });
    }
  }

  /**
   * Validates the join token (SCRUM-38), then confirms the authenticated user actually
   * has access to `docId` — owner or collaborator, per `docs`/`doc_collaborators`
   * (SCRUM-41) — before subscribing the client to the doc's broadcast group and handing
   * back its full current state. Either check failing rejects via an `error` message
   * before any join side effect happens — no partial join. This also means `docId` must
   * already exist as a real `docs` row (created via `POST /docs`, SCRUM-39): a client
   * can no longer implicitly create a doc just by joining an arbitrary id, which is the
   * whole point of this ticket — SyncGateway used to accept any docId from any client
   * with zero authorization.
   */
  private async handleJoin(
    client: LatticeSocket,
    docId: string,
    token: string,
  ): Promise<void> {
    let payload: AuthTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AuthTokenPayload>(token);
    } catch {
      this.send(client, {
        type: 'error',
        code: 'unauthorized',
        message: 'Invalid or expired token',
      });
      return;
    }

    const hasAccess = await this.docsAccess.findAccessible(docId, payload.sub);
    if (!hasAccess) {
      // Same error for "doc doesn't exist" and "doc exists but you have no access" —
      // deliberately, same reasoning as DocsController (SCRUM-40): distinguishing the
      // two would let a client enumerate real doc IDs.
      this.send(client, {
        type: 'error',
        code: 'forbidden',
        message: 'You do not have access to this doc',
      });
      return;
    }

    client.userId = payload.sub;
    client.email = payload.email;
    client.docId = docId;
    const isFirstLocalClient = this.connections.add(docId, client);

    // Presence is added locally now (synchronous), not after subscribing below — see
    // the comment on subscribePresence's placement further down for why the ORDER
    // between these two matters, not just that both happen.
    const isNewPresence = this.presence.add(
      docId,
      payload.sub,
      payload.email,
      client.clientId,
    );

    // Doc-update subscription stays early, per its own established rationale
    // (subscribing before reading the snapshot below avoids missing an update that
    // lands in the gap between the two).
    if (isFirstLocalClient) {
      await this.fanout.subscribe(docId, (envelope) =>
        this.handleRemoteUpdate(docId, envelope),
      );
    }

    const doc = await this.docRegistry.getOrCreate(docId);
    this.send(client, {
      type: 'joined',
      docId,
      initialState: toBase64(Y.encodeStateAsUpdate(doc)),
    });

    // The joining client always gets the current roster; OTHER LOCAL clients only
    // need telling when the roster actually changed (a genuinely new user, not just
    // another open tab). Note this snapshot may not yet include remote users on other
    // instances if this was the first local client (the roll-call requested below
    // hasn't gone out, let alone come back, yet) — it self-corrects within one Redis
    // round trip via a follow-up `presence` broadcast, same as handleRemotePresence's
    // `joined` case below.
    this.send(client, {
      type: 'presence',
      docId,
      users: this.presence.list(docId),
    });
    if (isNewPresence) this.broadcastPresence(docId, client.clientId);

    // Presence-channel subscription happens LAST, deliberately, not alongside the
    // doc-update subscription above. Verified directly against real Redis (not just
    // ioredis-mock, whose in-process delivery is fast enough to never expose this):
    // subscribing earlier registers handleRemotePresence before this client's own
    // `joined`/`presence` messages have been sent, and a fast-enough roll-call
    // response from another instance — or even this client's own roll-call request
    // echoing back — can be processed and broadcast to this client's OWN socket
    // (already present in ConnectionRegistryService by now) before either of those
    // sends happen, arriving out of order. Subscribing only after both sends removes
    // the window entirely: nothing can be delivered through a handler that isn't
    // registered yet. No equivalent gap risk is introduced by waiting — unlike doc
    // updates, presence has no "read a definitive snapshot" step in between that a
    // late subscribe could miss; the current local roster it already sent is complete
    // as far as local knowledge goes, and remote knowledge only ever arrives via this
    // same asynchronous, self-correcting roll-call round trip regardless of exactly
    // when the subscription starts.
    if (isFirstLocalClient) {
      await this.fanout.subscribePresence(docId, (envelope) =>
        this.handleRemotePresence(docId, envelope),
      );
    }

    // Cross-instance fan-out: published unconditionally (not gated on
    // isNewPresence), so every OTHER instance's own PresenceRegistryService ends up
    // with the exact same clientId-level state this instance has, not just a summary
    // — see handleRemotePresence's `joined` case for why each instance independently
    // re-deriving "is this new to ME" from that full state is what makes this correct
    // rather than redundant.
    this.fanout
      .publishPresence(docId, {
        kind: 'joined',
        userId: payload.sub,
        email: payload.email,
        clientId: client.clientId,
      })
      .catch((err: unknown) => this.logger.error(err));
  }

  /**
   * Reports a client's own cursor position, throttled per connection
   * (CursorThrottleService, SCRUM-46) since position changes far more often than
   * document content. Silently ignored if the client hasn't completed a `join` for
   * this exact `docId` — there's no meaningful "whose cursor is this" without an
   * authenticated, joined identity, and this is routine enough (a stray message
   * before `join` finishes, or for a doc the client isn't on) that an `error`
   * response would be noise rather than signal.
   *
   * Publishes only — no direct local broadcast. Unlike `joined`/`left`, a cursor
   * update has no "is this new" gate to get stale on the origin's own echo (every
   * cursor envelope is unconditionally forwarded, see handleRemotePresence's `cursor`
   * case), so there's no correctness reason to special-case local delivery here the
   * way handleJoin/handleDisconnect do — this can go through the SAME one path
   * (through Redis, including back to this instance's own other local sockets) that
   * document updates already use, per ADR-0005 §2.
   */
  private handleCursor(
    client: LatticeSocket,
    docId: string,
    position: number,
  ): void {
    if (!client.userId || client.docId !== docId) return;
    const userId = client.userId;
    this.cursorThrottle.submit(
      client.clientId,
      { userId, position },
      (update) => {
        this.fanout
          .publishPresence(docId, {
            kind: 'cursor',
            fromClientId: client.clientId,
            userId: update.userId,
            position: update.position,
          })
          .catch((err: unknown) => this.logger.error(err));
      },
    );
  }

  /**
   * Handles a message from `docId`'s presence Redis channel — from another instance,
   * or this instance's own publish echoing back through its own subscription (same as
   * handleRemoteUpdate for document content). Each instance applies every envelope to
   * its OWN PresenceRegistryService independently and decides independently whether
   * to notify its OWN local clients; this is what makes it safe for
   * handleJoin/handleDisconnect to ALSO update presence and broadcast directly
   * (immediate, no round-trip) without double-notifying local siblings once the echo
   * arrives — by then, this instance's own state already reflects the change, so its
   * own `isNewPresence`/`wasLastConnection` check here correctly comes back false.
   */
  private handleRemotePresence(
    docId: string,
    envelope: PresenceChannelEnvelope,
  ): void {
    switch (envelope.kind) {
      case 'roll-call':
        // A DIFFERENT instance just subscribed (its first local client for this doc)
        // and has no way to know about connections that predate its subscription —
        // Redis pub/sub doesn't replay history. Re-announce every LOCAL socket this
        // instance already knows about so that instance (and transitively, every
        // instance, including this one's own echo) converges on the full picture.
        for (const socket of this.connections.getSockets(docId)) {
          if (!socket.userId || !socket.email) continue;
          this.fanout
            .publishPresence(docId, {
              kind: 'joined',
              userId: socket.userId,
              email: socket.email,
              clientId: socket.clientId,
            })
            .catch((err: unknown) => this.logger.error(err));
        }
        return;
      case 'joined': {
        const isNewPresence = this.presence.add(
          docId,
          envelope.userId,
          envelope.email,
          envelope.clientId,
        );
        if (isNewPresence) this.broadcastPresence(docId, envelope.clientId);
        return;
      }
      case 'left': {
        const wasLastConnection = this.presence.remove(
          docId,
          envelope.userId,
          envelope.clientId,
        );
        if (wasLastConnection) {
          this.broadcastPresence(docId, envelope.clientId);
        }
        return;
      }
      case 'cursor':
        this.broadcastToOthers(docId, envelope.fromClientId, {
          type: 'cursor',
          docId,
          userId: envelope.userId,
          position: envelope.position,
        });
        return;
    }
  }

  /** Sends `docId`'s current presence roster to every OTHER local client on that doc. */
  private broadcastPresence(docId: string, exceptClientId: string): void {
    this.broadcastToOthers(docId, exceptClientId, {
      type: 'presence',
      docId,
      users: this.presence.list(docId),
    });
  }

  private broadcastToOthers(
    docId: string,
    exceptClientId: string,
    message: ServerMessage,
  ): void {
    for (const socket of this.connections.getSockets(docId)) {
      if (socket.clientId === exceptClientId) continue;
      this.send(socket, message);
    }
  }

  /** Computes and returns exactly what the client is missing, per its state vector. */
  private async handleSyncRequest(
    client: LatticeSocket,
    docId: string,
    stateVectorB64: string,
  ): Promise<void> {
    const doc = await this.docRegistry.getOrCreate(docId);
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
    const doc = await this.docRegistry.getOrCreate(docId);
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
    const doc = await this.docRegistry.getOrCreate(docId);
    // Idempotent: a no-op if this instance already applied it locally in handleUpdate.
    Y.applyUpdate(doc, fromBase64(envelope.update));
    this.snapshotScheduler.schedule(docId, doc);

    this.broadcastToOthers(docId, envelope.fromClientId, {
      type: 'update',
      docId,
      update: envelope.update,
      fromClientId: envelope.fromClientId,
    });
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
