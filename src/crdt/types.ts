/**
 * Core CRDT type definitions for Lattice's RGA (Replicated Growable Array) engine.
 *
 * This file defines the DATA MODEL only — no implementation logic (insert/delete/merge). See docs/notes/rga-summary.md for the
 * conceptual background behind these types.
 *
 */

/**
 * Uniquely identifies a single operation (an inserted or deleted element) across all
 * replicas. Composed of the client that created it plus a per-client logical counter
 * (Lamport-style clock). No two clients can ever produce the same OperationId, since
 * clientId is part of the identity.
 *
 * Example: the 5th operation Alice's client ever made -> { clientId: "alice", counter: 5 }
 */
export interface OperationId {
    readonly clientId: string;
    readonly counter: number;
  }
  
  /**
   * A special sentinel OperationId representing "the start of the document" — used as
   * the origin for the very first character ever inserted, since it has no real
   * preceding node to reference.
   */
  export const ROOT_ORIGIN: OperationId = {
    clientId: '__root__',
    counter: 0,
  };
  
  /**
   * An insertion of a single element (e.g. one character) into the sequence.
   *
   * Position is expressed relative to neighboring node identities, not a numeric index
   * (see docs/notes/rga-summary.md, §2 and §7 for why). `leftOrigin` is required —
   * every insert must anchor to what it was inserted after. `rightOrigin` is optional
   * for the initial hand-rolled implementation (basic RGA only needs left origin); it's
   * included here so the type can later support a YATA-style dual-origin approach
   * without a breaking change, per the terminology notes on origins.
   */
  export interface InsertOp {
    readonly type: 'insert';
    readonly id: OperationId;
    readonly value: string;
    readonly leftOrigin: OperationId;
    /**
     * ID of the node this element is inserted immediately before, at the time of
     * insertion. Optional for the v1 hand-rolled RGA (see ADR-0001); reserved for a
     * future YATA-style refinement.
     */
    readonly rightOrigin?: OperationId;
  }
  
  /**
   * A deletion of a previously-inserted element. Deletion never removes a node from the
   * underlying structure — it marks the referenced node as a tombstone (see
   * docs/notes/rga-summary.md, §5). The deleted node remains addressable by ID so any
   * operation that already referenced it (as a leftOrigin/rightOrigin) stays valid.
   */
  export interface DeleteOp {
    readonly type: 'delete';
    readonly id: OperationId;
    readonly targetId: OperationId;
  }
  
  /**
   * Any operation that can be applied to the CRDT. Discriminated union on `type`, so
   * consumers can narrow with a simple switch/if on `op.type`.
   */
  export type CRDTOperation = InsertOp | DeleteOp;