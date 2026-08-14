import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';

export const CURSOR_THROTTLE_MS = Symbol('CURSOR_THROTTLE_MS');

export interface CursorUpdate {
  userId: string;
  position: number;
}

interface PendingBroadcast {
  latest: CursorUpdate;
  timer: NodeJS.Timeout;
}

/**
 * Leading + trailing throttle, keyed by an arbitrary string (SyncGateway uses a
 * connection's `clientId`, so each open tab/socket gets its own independent window
 * rather than sharing one across a user's multiple connections).
 *
 * Cursor position changes far more often than document content — every keystroke or
 * mouse move, not every meaningful edit — so broadcasting each update one-for-one to
 * every other client would flood the connection under normal typing. This differs
 * from SnapshotSchedulerService's throttle (SCRUM-30, delayed-only): cursor movement
 * is live UI feedback, where the FIRST update in a quiet window should be delivered
 * immediately (a cursor that only starts moving after a visible lag feels broken), so
 * this fires on the leading edge too. Further updates within `intervalMs` are
 * coalesced into a single trailing broadcast of the LATEST position once the window
 * closes, rather than dropped — without a trailing edge, a cursor that stops moving
 * mid-window would appear frozen at a stale position for up to `intervalMs`.
 *
 * `intervalMs` defaults to a value tuned via SCRUM-58's k6 load test (see
 * sync.module.ts and load-test/README.md), not the original untuned placeholder
 * DESIGN.md §8 flagged.
 *
 * Ticket: SCRUM-46 (LAT-E5)
 */
@Injectable()
export class CursorThrottleService implements OnModuleDestroy {
  private readonly pending = new Map<string, PendingBroadcast>();

  constructor(
    @Inject(CURSOR_THROTTLE_MS) private readonly intervalMs: number,
  ) {}

  submit(
    key: string,
    update: CursorUpdate,
    broadcast: (update: CursorUpdate) => void,
  ): void {
    const existing = this.pending.get(key);
    if (existing) {
      existing.latest = update;
      return;
    }

    broadcast(update); // leading edge
    const entry: PendingBroadcast = {
      latest: update,
      timer: null as unknown as NodeJS.Timeout,
    };
    entry.timer = setTimeout(() => {
      this.pending.delete(key);
      // Reference check, not a value comparison: `entry.latest` is only ever
      // reassigned to a NEW object above, so this is true exactly when at least one
      // more update arrived during the throttle window after the leading edge fired.
      if (entry.latest !== update) broadcast(entry.latest);
    }, this.intervalMs);
    entry.timer.unref();
    this.pending.set(key, entry);
  }

  onModuleDestroy(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
