import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_PUBLISHER, REDIS_SUBSCRIBER } from './redis.provider';

/** What travels over a doc's Redis channel: a Yjs update plus who originated it. */
export interface UpdateEnvelope {
  fromClientId: string;
  /** base64-encoded Yjs update, matching the WS wire format in protocol.ts. */
  update: string;
}

function channelFor(docId: string): string {
  return `doc:${docId}`;
}

/**
 * Redis pub/sub fan-out for Yjs updates across server instances, per DESIGN.md §6:
 * one channel per doc (`doc:<id>`), subscribed only while at least one local client
 * cares about that doc — see ConnectionRegistryService, which drives subscribe/
 * unsubscribe based on local socket counts.
 *
 * Ticket: SCRUM-29 (LAT-E1B)
 */
type UpdateHandler = (envelope: UpdateEnvelope) => void | Promise<void>;

@Injectable()
export class RedisFanoutService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisFanoutService.name);
  private readonly handlers = new Map<string, UpdateHandler>();

  constructor(
    @Inject(REDIS_PUBLISHER) private readonly publisher: Redis,
    @Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis,
  ) {
    this.subscriber.on('message', (channel: string, raw: string) => {
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

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
  }
}
