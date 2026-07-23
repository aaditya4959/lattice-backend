import { LogicalClock, compareOperationId, operationIdEquals } from './clock';
import { OperationId } from './types';

describe('LogicalClock', () => {
  describe('uniqueness across clients', () => {
    it('never generates colliding IDs between two different clients', () => {
      const alice = new LogicalClock('alice');
      const bob = new LogicalClock('bob');

      const seen = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const aliceId = alice.next();
        const bobId = bob.next();

        const aliceKey = `${aliceId.clientId}:${aliceId.counter}`;
        const bobKey = `${bobId.clientId}:${bobId.counter}`;

        // Even though alice and bob's counters advance in lockstep here (both reach
        // the same counter value on the same iteration), their clientIds differ, so
        // their IDs must never collide.
        expect(seen.has(aliceKey)).toBe(false);
        expect(seen.has(bobKey)).toBe(false);
        seen.add(aliceKey);
        seen.add(bobKey);
      }

      expect(seen.size).toBe(2000);
    });

    it('never generates a duplicate ID from the same client', () => {
      const alice = new LogicalClock('alice');
      const seen = new Set<number>();

      for (let i = 0; i < 500; i++) {
        const id = alice.next();
        expect(seen.has(id.counter)).toBe(false);
        seen.add(id.counter);
      }
    });

    it('throws if constructed with an empty clientId', () => {
      expect(() => new LogicalClock('')).toThrow();
    });
  });

  describe('counter behavior', () => {
    it('starts counters at 1, not 0 (0 is reserved for ROOT_ORIGIN)', () => {
      const clock = new LogicalClock('alice');
      const first = clock.next();
      expect(first.counter).toBe(1);
    });

    it('increments monotonically on each call', () => {
      const clock = new LogicalClock('alice');
      const counters = [clock.next().counter, clock.next().counter, clock.next().counter];
      expect(counters).toEqual([1, 2, 3]);
    });

    it('observe() advances the counter to at least the observed value', () => {
      const clock = new LogicalClock('alice');
      clock.next(); // counter = 1
      clock.observe(10);
      expect(clock.currentCounter()).toBe(10);
      const next = clock.next();
      expect(next.counter).toBe(11);
    });

    it('observe() does not move the counter backwards', () => {
      const clock = new LogicalClock('alice');
      clock.next();
      clock.next();
      clock.next(); // counter = 3
      clock.observe(1); // lower than current, should be a no-op
      expect(clock.currentCounter()).toBe(3);
    });
  });
});

describe('compareOperationId', () => {
  it('orders by counter first', () => {
    const a: OperationId = { clientId: 'zebra', counter: 1 };
    const b: OperationId = { clientId: 'alice', counter: 2 };
    expect(compareOperationId(a, b)).toBeLessThan(0);
    expect(compareOperationId(b, a)).toBeGreaterThan(0);
  });

  it('breaks ties on equal counters using clientId', () => {
    const a: OperationId = { clientId: 'alice', counter: 5 };
    const b: OperationId = { clientId: 'bob', counter: 5 };
    expect(compareOperationId(a, b)).toBeLessThan(0);
    expect(compareOperationId(b, a)).toBeGreaterThan(0);
  });

  it('returns 0 for identical IDs', () => {
    const a: OperationId = { clientId: 'alice', counter: 5 };
    const b: OperationId = { clientId: 'alice', counter: 5 };
    expect(compareOperationId(a, b)).toBe(0);
  });

  it('produces a consistent total order (no contradictions) across a random set', () => {
    const clients = ['alice', 'bob', 'carol', 'dave'];
    const ids: OperationId[] = [];
    for (let i = 0; i < 50; i++) {
      const clientId = clients[Math.floor(Math.random() * clients.length)];
      const counter = Math.floor(Math.random() * 20) + 1;
      ids.push({ clientId, counter });
    }

    const sorted = [...ids].sort(compareOperationId);

    // Totality + transitivity check: every adjacent pair in the sorted result must
    // satisfy compareOperationId(sorted[i], sorted[i+1]) <= 0. If the comparator were
    // inconsistent, sorting would produce contradictory adjacent pairs.
    for (let i = 0; i < sorted.length - 1; i++) {
      expect(compareOperationId(sorted[i], sorted[i + 1])).toBeLessThanOrEqual(0);
    }
  });
});

describe('operationIdEquals', () => {
  it('returns true for identical clientId and counter', () => {
    const a: OperationId = { clientId: 'alice', counter: 5 };
    const b: OperationId = { clientId: 'alice', counter: 5 };
    expect(operationIdEquals(a, b)).toBe(true);
  });

  it('returns false when clientId differs', () => {
    const a: OperationId = { clientId: 'alice', counter: 5 };
    const b: OperationId = { clientId: 'bob', counter: 5 };
    expect(operationIdEquals(a, b)).toBe(false);
  });

  it('returns false when counter differs', () => {
    const a: OperationId = { clientId: 'alice', counter: 5 };
    const b: OperationId = { clientId: 'alice', counter: 6 };
    expect(operationIdEquals(a, b)).toBe(false);
  });
});