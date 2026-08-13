/**
 * WebSocket wire protocol for the sync gateway.
 *
 * This adapts docs/DESIGN.md §4.2's message schema for Yjs. The original schema was
 * written around the hand-rolled RGA's `CRDTOperation` type (see src/crdt/types.ts);
 * per ADR-0004, that engine was never wired to the network, so `op: CRDTOperation`
 * never shipped. Yjs has no equivalent "one operation" shape — it only exchanges
 * opaque binary updates and state vectors (see src/sync/yjs.smoke.spec.ts) — so this
 * version keeps DESIGN.md's message *names* and flat `{ type, ... }` JSON envelope,
 * but replaces `op`/`missingOps` payloads with base64-encoded Yjs binary. `ping`/`pong`
 * are still intentionally out of scope. `cursor`/`presence` were deferred alongside
 * them (no presence ticket yet) until SCRUM-46 added them. This deviation from
 * DESIGN.md's original sketch is exactly what ADR-0005 (Yjs-specific integration
 * decisions) formalizes.
 *
 * `join`'s `token` field was deferred back in SCRUM-28 (no AuthModule existed yet) and
 * reinstated in SCRUM-38 once one did — see SyncGateway.handleJoin for validation.
 *
 * Binary fields are base64 strings, not raw Uint8Array, because these messages travel
 * as JSON text frames (matching DESIGN.md's "all messages are JSON" convention) rather
 * than switching to raw binary framing.
 *
 * Ticket: SCRUM-28 (LAT-E1B), SCRUM-38 (LAT-E2), SCRUM-46 (LAT-E5)
 */

/** A single connected user, as reported in a `presence` snapshot. */
export interface PresenceUser {
  userId: string;
  email: string;
}

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
  | { type: 'update'; docId: string; update: string }
  /**
   * A raw text position (not a Yjs-relative anchor) — good enough for a live "where's
   * everyone looking" indicator. Anchoring cursors to CRDT positions so they survive
   * concurrent edits without drifting is real additional complexity DESIGN.md doesn't
   * ask for here; ADR-0007 documents this as a deliberate scope boundary, not an
   * oversight.
   */
  | { type: 'cursor'; docId: string; position: number };

export type ServerMessage =
  | { type: 'joined'; docId: string; initialState: string }
  /** The other half of the reconnect/resync protocol — see `sync-request` above. */
  | { type: 'sync-response'; docId: string; update: string }
  | { type: 'update'; docId: string; update: string; fromClientId: string }
  /**
   * The full current roster for a doc, sent to a client right after `joined` and
   * re-sent to everyone whenever the SET of connected users changes (someone's first
   * connection or last disconnection) — not on every reconnect from an already-present
   * user's second tab. Cursor movement is a much higher-frequency, separate `cursor`
   * broadcast (below), kept out of this message so a roster update doesn't imply
   * resending everyone's positions too.
   */
  | { type: 'presence'; docId: string; users: PresenceUser[] }
  /** One user's throttled cursor position (see ClientMessage's `cursor` and CursorThrottleService). */
  | { type: 'cursor'; docId: string; userId: string; position: number }
  | { type: 'error'; code: string; message: string };
