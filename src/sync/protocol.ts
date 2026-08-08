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
 * `presence`, `ping`/`pong`, and `join`'s `token` are intentionally out of scope here
 * (no AuthModule yet, no presence ticket yet) and are not included below. This
 * deviation from DESIGN.md's original sketch is exactly what ticket SCRUM-34 (ADR:
 * Yjs-specific integration decisions) exists to formalize.
 *
 * Binary fields are base64 strings, not raw Uint8Array, because these messages travel
 * as JSON text frames (matching DESIGN.md's "all messages are JSON" convention) rather
 * than switching to raw binary framing.
 *
 * Ticket: SCRUM-28 (LAT-E1B)
 */

export type ClientMessage =
  | { type: 'join'; docId: string }
  | { type: 'sync-request'; docId: string; stateVector: string }
  | { type: 'update'; docId: string; update: string };

export type ServerMessage =
  | { type: 'joined'; docId: string; initialState: string }
  | { type: 'sync-response'; docId: string; update: string }
  | { type: 'update'; docId: string; update: string; fromClientId: string }
  | { type: 'error'; code: string; message: string };
