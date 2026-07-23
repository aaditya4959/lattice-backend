import { RGA, ROOT_ORIGIN } from './rga';
import { LogicalClock } from './clock';
import { InsertOp, OperationId } from './types';

/** Small test helper: builds an InsertOp from a clock + value + leftOrigin. */
function makeInsert(clock: LogicalClock, value: string, leftOrigin: OperationId): InsertOp {
  return {
    type: 'insert',
    id: clock.next(),
    value,
    leftOrigin,
  };
}

describe('RGA insert — sequential single-client typing', () => {
  it('produces correctly ordered output when typing forward, one character at a time', () => {
    const rga = new RGA();
    const clock = new LogicalClock('alice');

    // Simulates typing "hello" left-to-right: each new character's leftOrigin is the
    // previously inserted character's ID (or ROOT_ORIGIN for the very first one).
    let cursor: OperationId = ROOT_ORIGIN;
    for (const char of 'hello') {
      const op = makeInsert(clock, char, cursor);
      rga.insert(op);
      cursor = op.id;
    }

    expect(rga.toString()).toBe('hello');
    expect(rga.toArray()).toEqual(['h', 'e', 'l', 'l', 'o']);
  });

  it('starts with an empty document', () => {
    const rga = new RGA();
    expect(rga.toArray()).toEqual([]);
    expect(rga.toString()).toBe('');
  });

  it('correctly inserts in the middle when the user moves the cursor back', () => {
    const rga = new RGA();
    const clock = new LogicalClock('alice');

    // Type "helo"
    let cursor: OperationId = ROOT_ORIGIN;
    const ids: OperationId[] = [];
    for (const char of 'helo') {
      const op = makeInsert(clock, char, cursor);
      rga.insert(op);
      ids.push(op.id);
      cursor = op.id;
    }
    expect(rga.toString()).toBe('helo');

    // Now move the cursor back and insert "l" right after the first "l" (ids[2]),
    // simulating the user fixing a typo: "helo" -> "hello"
    const fixOp = makeInsert(clock, 'l', ids[2]);
    rga.insert(fixOp);

    expect(rga.toString()).toBe('hello');
  });

  it('supports inserting at the very start of the document', () => {
    const rga = new RGA();
    const clock = new LogicalClock('alice');

    const first = makeInsert(clock, 'b', ROOT_ORIGIN);
    rga.insert(first);
    expect(rga.toString()).toBe('b');

    // Insert "a" before "b" by anchoring to ROOT_ORIGIN again — since "a" is a newer
    // operation than "b" (higher counter), the tie-break rule places it closer to
    // root, i.e. before "b".
    const second = makeInsert(clock, 'a', ROOT_ORIGIN);
    rga.insert(second);

    expect(rga.toString()).toBe('ab');
  });

  it('is idempotent — applying the same insert op twice is a no-op', () => {
    const rga = new RGA();
    const clock = new LogicalClock('alice');

    const op = makeInsert(clock, 'x', ROOT_ORIGIN);
    rga.insert(op);
    rga.insert(op); // duplicate application, e.g. a retried network message

    expect(rga.toString()).toBe('x');
    expect(rga.size()).toBe(1);
  });

  it('throws if leftOrigin references an unknown node', () => {
    const rga = new RGA();
    const clock = new LogicalClock('alice');
    const bogusOrigin: OperationId = { clientId: 'nobody', counter: 999 };

    expect(() => rga.insert(makeInsert(clock, 'x', bogusOrigin))).toThrow();
  });
});

describe('RGA insert — same-origin sibling tie-break (documented behavior)', () => {
  it('places a newer operation closer to a shared origin than an older sibling', () => {
    // This test documents a real, expected property of the tie-break rule (see
    // docs/notes/rga-summary.md, §4): if two inserts reference the SAME leftOrigin,
    // the one with the higher (newer) OperationId ends up closer to that origin.
    // In normal sequential typing this doesn't occur (each new char anchors to the
    // previous one), but it's the exact mechanism that resolves genuinely concurrent
    // inserts at the same position between two different clients (see LAT-15/LAT-16).
    const rga = new RGA();
    const clock = new LogicalClock('alice');

    const root = makeInsert(clock, 'h', ROOT_ORIGIN);
    rga.insert(root);

    const firstChild = makeInsert(clock, 'a', root.id); // anchored to "h"
    rga.insert(firstChild);
    expect(rga.toString()).toBe('ha');

    const secondChild = makeInsert(clock, 'b', root.id); // also anchored to "h"
    rga.insert(secondChild); // has a higher counter than firstChild -> sorts closer to "h"

    expect(rga.toString()).toBe('hba');
  });
});

describe('RGA — size and has()', () => {
  it('tracks size excluding the root sentinel', () => {
    const rga = new RGA();
    const clock = new LogicalClock('alice');
    expect(rga.size()).toBe(0);

    rga.insert(makeInsert(clock, 'a', ROOT_ORIGIN));
    rga.insert(makeInsert(clock, 'b', ROOT_ORIGIN));
    expect(rga.size()).toBe(2);
  });

  it('has() reflects whether a node has been inserted', () => {
    const rga = new RGA();
    const clock = new LogicalClock('alice');
    const op = makeInsert(clock, 'a', ROOT_ORIGIN);

    expect(rga.has(op.id)).toBe(false);
    rga.insert(op);
    expect(rga.has(op.id)).toBe(true);
  });
});