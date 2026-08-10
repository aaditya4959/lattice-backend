import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as Y from 'yjs';
import { SnapshotService } from './snapshot.service';

export const SNAPSHOT_INTERVAL_MS = Symbol('SNAPSHOT_INTERVAL_MS');

/**
 * Throttles snapshot writes per DESIGN.md §6 ("Snapshot writes: batched/debounced —
 * not on every single op — to avoid hammering Postgres under high edit frequency").
 *
 * This is throttling, not trailing debounce: the first update after a quiet period
 * schedules a write `intervalMs` later, and further updates arriving before that
 * timer fires don't push it back out. Trailing debounce (reset the timer on every
 * update) would starve snapshots entirely under continuous typing, since the timer
 * would never get a chance to fire. Throttling guarantees a write at least once every
 * `intervalMs` during sustained activity, capturing whatever the doc's live state is
 * at the moment the timer fires — always current, since `Y.Doc` is a live mutable
 * object, not a value snapshotted at schedule time.
 *
 * `intervalMs` is a placeholder default, not a tuned value — DESIGN.md §8 explicitly
 * flags the right debounce interval as needing empirical tuning once load-testing is
 * in place. Injected via SNAPSHOT_INTERVAL_MS so it's overridable (env var in
 * production, a short value in tests) without touching this class.
 *
 * Ticket: SCRUM-30 (LAT-E1B)
 */
@Injectable()
export class SnapshotSchedulerService implements OnModuleDestroy {
  private readonly logger = new Logger(SnapshotSchedulerService.name);
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly snapshots: SnapshotService,
    @Inject(SNAPSHOT_INTERVAL_MS) private readonly intervalMs: number,
  ) {}

  schedule(docId: string, doc: Y.Doc): void {
    if (this.pending.has(docId)) return;
    const timer = setTimeout(() => {
      this.pending.delete(docId);
      const state = Y.encodeStateAsUpdate(doc);
      const stateVector = Y.encodeStateVector(doc);
      this.snapshots
        .save(docId, state, stateVector)
        .catch((err: unknown) => this.logger.error(err));
    }, this.intervalMs);
    timer.unref();
    this.pending.set(docId, timer);
  }

  onModuleDestroy(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
