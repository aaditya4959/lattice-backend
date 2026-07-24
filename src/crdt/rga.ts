import { InsertOp, OperationId, ROOT_ORIGIN } from './types';
import { compareOperationId } from './clock';

/**
 * Internal node representation for the RGA linked-list structure. Not exported —
 * external code interacts with the RGA class's public API only (insert, toArray),
 * never with nodes directly.
 *
 * `isDeleted` is included now (default false) even though delete logic isn't
 * implemented until LAT-14, so this node shape doesn't need a breaking change later.
 */
interface RGANode {
  readonly id: OperationId;
  readonly value: string;
  readonly leftOrigin: OperationId;
  isDeleted: boolean;
  next: RGANode | null;
}

/** Serializes an OperationId into a stable string key for use in the internal Map. */
function idKey(id: OperationId): string {
  return `${id.clientId}:${id.counter}`;
}

/**
 * RGA (Replicated Growable Array) — a CRDT sequence structure.
 *
 * Represents an ordered sequence as a linked list of permanently-identified nodes,
 * where position is expressed relative to a neighbor's ID (leftOrigin) rather than a
 * numeric array index. See docs/notes/rga-summary.md for the full conceptual
 * background.
 *
 * This ticket (LAT-13) implements insertion only. Deletion (tombstones) is LAT-14;
 * remote-operation merging is LAT-15.
 *
 * Known simplification (documented per ADR-0001's hand-roll-to-learn approach): this
 * implementation resolves insertion position by directly comparing OperationIds among
 * immediate siblings of the same leftOrigin. This is correct for the common cases
 * exercised here (sequential single-client typing, and simple concurrent inserts at a
 * shared origin) but does not implement YATA's dual-origin refinement — deeper nested
 * concurrent-insert scenarios may order differently than a production library like Yjs.
 * That gap is intentional and is exactly what ADR-0001 documents as the reason to swap
 * to Yjs for the networked application.
 */
export class RGA {
  private readonly nodes = new Map<string, RGANode>();
  private readonly root: RGANode;

  constructor() {
    // The root is a sentinel node representing "the start of the document." It is
    // never visible in the rendered output and cannot be deleted.
    this.root = {
      id: ROOT_ORIGIN,
      value: '',
      leftOrigin: ROOT_ORIGIN,
      isDeleted: true, // sentinel is always excluded from visible output
      next: null,
    };
    this.nodes.set(idKey(ROOT_ORIGIN), this.root);
  }

  /**
   * Applies an insert operation to the structure.
   *
   * Algorithm:
   * 1. Locate the node referenced by `op.leftOrigin` (throws if unknown — a real
   *    networked system would buffer out-of-order ops instead; see LAT-15).
   * 2. Walk forward past any existing siblings inserted at the same origin whose ID
   *    is "greater" than the new operation's ID, per the total order from
   *    compareOperationId. Greater IDs sort closer to the origin — this is the
   *    deterministic tie-break rule from docs/notes/rga-summary.md, §4.
   * 3. Insert the new node immediately before the first sibling with a lesser ID
   *    (or at the end of the origin's sibling run, if none).
   */
  insert(op: InsertOp): void {
    if (this.nodes.has(idKey(op.id))) {
      // Idempotency: applying the same insert twice (e.g. a retried network message)
      // is a no-op, not an error. This is one of the three properties
      // (commutative/associative/idempotent) that guarantee convergence.
      return;
    }

    const originNode = this.nodes.get(idKey(op.leftOrigin));
    if (!originNode) {
      throw new Error(
        `Cannot insert op ${idKey(op.id)}: leftOrigin ${idKey(op.leftOrigin)} not found. ` +
          `A real networked client should buffer this operation until its dependency arrives (see LAT-15).`,
      );
    }

    const newNode: RGANode = {
      id: op.id,
      value: op.value,
      leftOrigin: op.leftOrigin,
      isDeleted: false,
      next: null,
    };

    let precedingNode = originNode;
    let candidate = originNode.next;

    while (candidate !== null && compareOperationId(candidate.id, newNode.id) > 0) {
      precedingNode = candidate;
      candidate = candidate.next;
    }

    newNode.next = precedingNode.next;
    precedingNode.next = newNode;
    this.nodes.set(idKey(newNode.id), newNode);
  }

  /**
   * Returns whether a node with the given ID currently exists in the structure
   * (regardless of deleted status). Useful for tests and for LAT-15's dependency
   * buffering logic.
   */
  has(id: OperationId): boolean {
    return this.nodes.has(idKey(id));
  }
  // dummy commit 

  /**
   * Renders the visible document as an array of values, in order, skipping tombstoned
   * nodes (isDeleted). Since delete isn't implemented until LAT-14, every node is
   * currently visible, but the filter is included now so callers have a stable API
   * that won't change shape once deletion lands.
   */
  toArray(): string[] {
    const result: string[] = [];
    let current = this.root.next;
    while (current !== null) {
      if (!current.isDeleted) {
        result.push(current.value);
      }
      current = current.next;
    }
    return result;
  }

  /** Convenience: joins toArray() into a single string, for text-editor use cases. */
  toString(): string {
    return this.toArray().join('');
  }

  /** Total count of nodes including tombstones — useful for LAT-17's benchmarking. */
  size(): number {
    return this.nodes.size - 1; // exclude the root sentinel
  }
}

export { ROOT_ORIGIN };