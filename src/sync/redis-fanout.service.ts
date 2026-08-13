import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_PUBLISHER, REDIS_SUBSCRIBER } from './redis.provider';

/** What travels over a doc's Redis channel: a Yjs update plus who originated it. */
export interface UpdateEnvelope {
  fromClientId: string;
  /** base64-encoded Yjs update, matching the WS wire format in protocol.ts. */
  update: string;
}

/**
 * What travels over a doc's PRESENCE Redis channel (SCRUM-47) — a separate channel
 * from `UpdateEnvelope`'s, so document content and presence/cursor traffic don't share
 * one subscription's message parsing, but still the SAME "always through Redis"
 * fan-out model (ADR-0005 §2), not a special-cased local-only path.
 *
 * `roll-call` exists because Redis pub/sub has no memory: an instance that only just
 * subscribed (its first local client for this doc) never saw any `joined` events
 * published before it subscribed, so it has no way to learn about already-connected
 * users on OTHER instances without asking. `subscribePresence` publishes one
 * immediately after subscribing; every already-subscribed instance responds by
 * re-publishing a `joined` for each of its own currently-connected local sockets (see
 * SyncGateway.handleRemotePresence).
 */
export type PresenceChannelEnvelope =
  | { kind: 'joined'; userId: string; email: string; clientId: string }
  | { kind: 'left'; userId: string; clientId: string }
  | { kind: 'cursor'; fromClientId: string; userId: string; position: number }
  | { kind: 'roll-call' };

function channelFor(docId: string): string {
  return `doc:${docId}`;
}

function presenceChannelFor(docId: string): string {
  return `presence:${docId}`;
}

/**
 * Redis pub/sub fan-out across server instances, per DESIGN.md §6: one channel per doc
 * for document updates (`doc:<id>`) and a second for presence/cursor (`presence:<id>`,
 * SCRUM-47), both subscribed only while at least one local client cares about that doc
 * — see ConnectionRegistryService, which drives subscribe/unsubscribe based on local
 * socket counts.
 *
 * Ticket: SCRUM-29 (LAT-E1B), SCRUM-47 (LAT-E5)
 */
type UpdateHandler = (envelope: UpdateEnvelope) => void | Promise<void>;
type PresenceHandler = (
  envelope: PresenceChannelEnvelope,
) => void | Promise<void>;

@Injectable()
export class RedisFanoutService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisFanoutService.name);
  private readonly handlers = new Map<string, UpdateHandler>();
  private readonly presenceHandlers = new Map<string, PresenceHandler>();

  constructor(
    @Inject(REDIS_PUBLISHER) private readonly publisher: Redis,
    @Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis,
  ) {
    this.subscriber.on('message', (channel: string, raw: string) => {
      if (channel.startsWith('presence:')) {
        const docId = channel.slice('presence:'.length);
        const handler = this.presenceHandlers.get(docId);
        if (!handler) return;
        Promise.resolve(
          handler(JSON.parse(raw) as PresenceChannelEnvelope),
        ).catch((err: unknown) => this.logger.error(err));
        return;
      }

      const docId = channel.slice('doc:'.length);
      const handler = this.handlers.get(docId);
      if (!handler) return;
      Promise.resolve(handler(JSON.parse(raw) as UpdateEnvelope)).catch(
        (err: unknown) => this.logger.error(err),
      );
    });
  }

  async publish(docId: string, envelope: UpdateEnvelope): Promise<void> {
    await this.publisher.publish(channelFor(docId), JSON.stringify(envelope));
  }

  /** Subscribes to `docId`'s channel and registers the handler for its messages. */
  async subscribe(docId: string, onMessage: UpdateHandler): Promise<void> {
    this.handlers.set(docId, onMessage);
    await this.subscriber.subscribe(channelFor(docId));
  }

  async unsubscribe(docId: string): Promise<void> {
    this.handlers.delete(docId);
    await this.subscriber.unsubscribe(channelFor(docId));
  }

  async publishPresence(
    docId: string,
    envelope: PresenceChannelEnvelope,
  ): Promise<void> {
    await this.publisher.publish(
      presenceChannelFor(docId),
      JSON.stringify(envelope),
    );
  }

  /**
   * Subscribes to `docId`'s presence channel and immediately requests a roll-call —
   * see the `PresenceChannelEnvelope` doc comment for why a fresh subscriber can't
   * just wait for the next organic event.
   */
  async subscribePresence(
    docId: string,
    onMessage: PresenceHandler,
  ): Promise<void> {
    this.presenceHandlers.set(docId, onMessage);
    await this.subscriber.subscribe(presenceChannelFor(docId));
    await this.publishPresence(docId, { kind: 'roll-call' });
  }

  async unsubscribePresence(docId: string): Promise<void> {
    this.presenceHandlers.delete(docId);
    await this.subscriber.unsubscribe(presenceChannelFor(docId));
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
  }
}
