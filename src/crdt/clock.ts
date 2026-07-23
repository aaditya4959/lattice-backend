import { OperationId } from './types';

/**
 * Per-client logical clock (Lamport-style) that generates unique OperationIds.
 *
 * Each LogicalClock instance belongs to exactly one client/replica. Every call to
 * `next()` increments an internal counter and returns a new OperationId. Because the
 * clientId is baked into every generated ID, two different clients can never produce
 * a colliding ID, even if their counters happen to reach the same value.
 *
 * See docs/notes/rga-summary.md, §3 for the conceptual background.
 *
 * Ticket: LAT-12
 */
export class LogicalClock {
  private counter = 0;

  constructor(private readonly clientId: string) {
    if (!clientId) {
      throw new Error('LogicalClock requires a non-empty clientId');
    }
  }

  /**
   * Generates the next unique OperationId for this client, incrementing the internal
   * counter. Counters start at 1 (0 is reserved for ROOT_ORIGIN, see types.ts).
   */
  next(): OperationId {
    this.counter += 1;
    return {
      clientId: this.clientId,
      counter: this.counter,
    };
  }

  /**
   * Advances the clock's counter to at least `observedCounter`, without generating an
   * ID. Used when receiving a remote operation with a higher counter than we've seen
   * locally, so our own subsequent IDs stay ahead of everything we know about — this
   * is the standard Lamport clock "receive" rule.
   */
  observe(observedCounter: number): void {
    if (observedCounter > this.counter) {
      this.counter = observedCounter;
    }
  }

  /** Returns the current counter value without advancing it. Useful for tests/debugging. */
  currentCounter(): number {
    return this.counter;
  }
}

/**
 * Compares two OperationIds to produce a total order (see docs/notes/rga-summary.md, §4
 * for what "total order" means and why it's needed for deterministic tie-breaking).
 *
 * Rule: compare counter first; if counters are equal, break the tie by comparing
 * clientId lexicographically. This guarantees any two distinct OperationIds are always
 * comparable, with no ties, and that every replica computes the same ordering.
 *
 * Returns:
 *   negative number if a < b
 *   positive number if a > b
 *   0 if a and b are identical (same clientId and counter)
 */
export function compareOperationId(a: OperationId, b: OperationId): number {
  if (a.counter !== b.counter) {
    return a.counter - b.counter;
  }
  if (a.clientId < b.clientId) return -1;
  if (a.clientId > b.clientId) return 1;
  return 0;
}

/** Returns true if two OperationIds refer to the exact same operation. */
export function operationIdEquals(a: OperationId, b: OperationId): boolean {
  return a.clientId === b.clientId && a.counter === b.counter;
}