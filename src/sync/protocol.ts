/**
 * WebSocket wire protocol for the sync gateway.
 *
 * This adapts docs/DESIGN.md §4.2's message schema for Yjs. The original schema was
 * written around the hand-rolled RGA's `CRDTOperation` type (see src/crdt/types.ts);
 * per ADR-0004, that engine was never wired to the network, so `op: CRDTOperation`
 * never shipped. Yjs has no equivalent "one operation" shape — it only exchanges
 * opaque binary updates and state vectors (see src/sync/yjs.smoke.spec.ts) — so this
 * version keeps DESIGN.md's message *names* and flat `{ type, ... }` JSON envelope,
 * but replaces `op`/`missingOps` payloads with base64-encoded Yjs binary. `cursor`,
 * `presence`, and `ping`/`pong` are intentionally out of scope here (no presence
 * ticket yet) and are not included below. This deviation from DESIGN.md's original
 * sketch is exactly what ADR-0005 (Yjs-specific integration decisions) formalizes.
 *
 * `join`'s `token` field was deferred back in SCRUM-28 (no AuthModule existed yet) and
 * reinstated in SCRUM-38 once one did — see SyncGateway.handleJoin for validation.
 *
 * Binary fields are base64 strings, not raw Uint8Array, because these messages travel
 * as JSON text frames (matching DESIGN.md's "all messages are JSON" convention) rather
 * than switching to raw binary framing.
 *
 * Ticket: SCRUM-28 (LAT-E1B), SCRUM-38 (LAT-E2)
 */

export type ClientMessage =
  | { type: 'join'; docId: string; token: string }
  /**
   * The reconnect/resync protocol (SCRUM-31): a client that already holds a copy of
   * the doc (from a prior `joined`, persisted locally, or just never having fully
   * disconnected) sends its own state vector — Yjs's compact summary of what it's
   * already seen (see src/sync/yjs.smoke.spec.ts) — instead of re-requesting the
   * whole document. Nothing distinguishes "reconnecting after a drop" from any other
   * `sync-request` at the protocol level; the state vector alone is sufficient for
   * the server to compute exactly the diff, whether that's "everything" (an empty
   * state vector) or "the last three ops that happened while you were offline."
   */
  | { type: 'sync-request'; docId: string; stateVector: string }
  | { type: 'update'; docId: string; update: string };

export type ServerMessage =
  | { type: 'joined'; docId: string; initialState: string }
  /** The other half of the reconnect/resync protocol — see `sync-request` above. */
  | { type: 'sync-response'; docId: string; update: string }
  | { type: 'update'; docId: string; update: string; fromClientId: string }
  | { type: 'error'; code: string; message: string };
