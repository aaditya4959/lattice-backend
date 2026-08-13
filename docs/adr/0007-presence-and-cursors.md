# ADR-0007: Presence & Cursor Design

**Status:** Accepted
**Date:** 2026-08-13
**Ticket:** SCRUM-50 (LAT-E5 / SCRUM-44)

## Context

`LAT-E5` closed the one v1 GOAL from `docs/DESIGN.md` left unbuilt since the project's
earliest sprints: knowing who else is looking at a doc, and roughly where. `protocol.ts`
had literally flagged this ("no presence ticket yet") since SCRUM-28. The feature landed
across four tickets — `PresenceRegistryService` (SCRUM-45), wiring cursor/presence into
`SyncGateway` plus `CursorThrottleService` (SCRUM-46), cross-instance fan-out over a
second Redis channel (SCRUM-47), and the `client/index.html` roster/badge UI (SCRUM-48)
— each making a scoping or design call inline rather than in one place. This ADR
consolidates the four decisions SCRUM-50 calls out: what presence tracks (users, not
sockets), what a cursor is (a raw position, not a CRDT anchor), how presence survives
horizontal scaling (Redis fan-out reuse, not a new mechanism), and what's deliberately
*not* persisted.

## Decision

### 1. Presence is ephemeral, in-memory, and never touches Postgres

`PresenceRegistryService` holds all state in a `Map`, per instance, with nothing written
to or read from Postgres. This mirrors `ConnectionRegistryService`'s existing shape
(SCRUM-29) rather than introducing a different persistence model for a conceptually
similar problem. Presence answers "who is here *right now*" — a question with no
meaningful answer once every socket for a doc has closed, unlike document content
(which must survive a restart) or account/doc metadata (which must survive to the next
session). Losing the in-memory roster on a crash or restart is not data loss, because
there was never anything durable to lose: every currently-connected client re-announces
itself via `join` regardless, which is exactly what rebuilds the roster.

### 2. Presence dedupes by user, not by socket

`PresenceRegistryService.add`/`remove` track a set of `clientId`s per `userId`
(`PresenceEntry.clientIds`) and only report a real join/leave event
(`isNewPresence`/`wasLastConnection`) on the *first* connection in / *last* connection
out. A user with two tabs open on the same doc is one entry in the roster others see —
matching what "who's viewing this doc" should mean to a human reading the list, not the
raw socket count `ConnectionRegistryService` already tracks for a different purpose
(routing document updates). Getting this wrong in either direction has a visible cost:
deduping by socket would show a phantom second person for every extra tab; not deduping
at all would spam a `presence` broadcast on every tab open/close even when the *set* of
present users hasn't changed.

### 3. Cursor position is a raw text offset, not a CRDT-anchored position

`ClientMessage`'s `cursor` variant carries a plain integer `position`, not a Yjs
relative position (`Y.RelativePosition`) or any other structure that survives concurrent
edits without drifting. This is a deliberate scope boundary: anchoring a cursor to a
CRDT position so it stays correct across concurrent inserts/deletes elsewhere in the
document is real additional complexity — it means threading Yjs's relative-position API
through the wire protocol and re-resolving it against the receiving client's local
doc state on every render — and `docs/DESIGN.md` never asked for this level of fidelity
for what's fundamentally a "roughly where is everyone looking" indicator, not a
collaborative-editing correctness requirement the way document content itself is. A
cursor that's briefly a few characters stale after a concurrent remote edit is a
cosmetic imprecision, not a convergence bug — a categorically different bar than
anything in `src/crdt/` or the Yjs integration (ADR-0004, ADR-0005). If cursor fidelity
ever becomes a real product requirement, this is the ADR to revisit and supersede, not
a silent upgrade.

### 4. Cursor broadcasts are throttled with a leading + trailing edge, not a plain interval

`CursorThrottleService` fires the *first* cursor update in a quiet window immediately
(leading edge), then coalesces any further updates within `CURSOR_THROTTLE_MS`
(default 100ms) into a single trailing broadcast of the *latest* position once the
window closes — rather than either broadcasting every update one-for-one (which would
flood every other client under normal typing, since cursor position changes far more
often than document content) or a plain fixed-interval sample (which would either delay
the very first movement, making the cursor feel laggy the instant someone starts
moving it, or drop a final position and leave a stale cursor visible for up to the
full interval after movement stops). Keyed per-connection (`clientId`, not `userId`),
matching `PresenceRegistryService`'s socket-vs-user distinction in reverse: cursor
position is inherently a per-tab concept (two tabs on the same doc can show different
positions), unlike roster membership. `CURSOR_THROTTLE_MS` is a placeholder default,
same caveat as `SNAPSHOT_INTERVAL_MS` (`docs/DESIGN.md` §8) — not empirically tuned.

### 5. Presence/cursor fan-out reuses the Redis pub/sub model, on a second channel

Cross-instance presence (SCRUM-47) is carried on `presence:<docId>`, a channel separate
from `doc:<docId>`'s document-update traffic, but built on the exact same principle
established in ADR-0005 §2: every subscribed instance receives every envelope,
including its own echo, and independently decides whether to notify its own local
clients — no special-cased "local-only" path that bypasses Redis for same-instance
delivery. A genuinely new problem this channel has that document updates don't:
**Redis pub/sub has no memory.** A newly-subscribing instance (this doc's first local
client on that instance) never received the `joined` events published before it
subscribed, so without help it would show an incomplete roster until the next organic
join/leave anywhere. `subscribePresence` closes this gap by publishing a `roll-call`
envelope immediately after subscribing; every *already*-subscribed instance responds by
re-publishing a `joined` for each of its own currently-connected local sockets
(`handleRemotePresence`'s `roll-call` case), so the new subscriber's roster converges to
correct within one Redis round trip instead of waiting on the next real event.
`joined`/`left` additionally get a direct, immediate local apply+broadcast in
`handleJoin`/`handleDisconnect` — mirroring `handleUpdate`'s existing direct-apply
pattern for document content — so the acting client's own local siblings don't wait on
a Redis round trip for their own instance's event. This is safe specifically because
that direct call updates local `PresenceRegistryService` state *before* the echo
arrives, so the echo's own `isNewPresence`/`wasLastConnection` check correctly comes
back `false` and skips a duplicate broadcast. `cursor` has no equivalent direct path:
every cursor update is unconditionally forwarded through Redis either way (there's
nothing to deduplicate — no "is this new" check the way join/leave has one), so routing
it through the same one path document updates already use is simpler, not a
missed optimization.

SCRUM-47 also surfaced and fixed a real ordering bug this design is sensitive to:
`subscribePresence` was originally called *before* `handleJoin` sent the joining
client's own `joined`/`presence` messages. A fast-enough `roll-call` response — including
the client's own instance answering its own roll-call — could be processed and
broadcast back to that same client's socket before either send had gone out, effectively
reordering the client's own view of its own join. Fixed by moving the presence-channel
subscribe to *after* both sends. This is the mirror image of, not a contradiction of,
document updates' subscribe-*before*-read ordering (`handleJoin`'s top comment,
ADR-0005) — that ordering exists to guarantee no update is missed in the gap between
"read the current snapshot" and "start receiving live updates." Presence has no
equivalent "read a definitive snapshot" step to protect: the joining client's own
`presence` message *is* the snapshot, constructed synchronously from local state, so
subscribing to the channel before or after sending it doesn't add or drop any
information. Only the visible timing of the client's own already-known state was
allowed to move.

### 6. The client harness shows a roster and a numeric badge, not rendered carets

`client/index.html`'s "Currently viewing" list and per-user cursor-position badge
(SCRUM-48) are the full extent of this project's client-side presence UI — no rendered
caret overlay tracking each user's live position inside the `<textarea>`. Two reasons,
not one: a plain `<textarea>` has no native way to render an arbitrary in-text marker at
all (it would require replacing the textarea with a `contenteditable` surface or a
canvas overlay, a much larger change), and — per this harness's existing charter (see
`client/index.html`'s own scope notes from SCRUM-31/48) — it exists as a minimal
manual-verification tool, not the product frontend. The local user is labeled "(you)"
by decoding their own JWT payload client-side purely for that display label; this is
explicitly not a security operation (nothing is validated or trusted from it) — same
category of client-side-only convenience as the rest of the harness.

## Consequences

**Gains:**

- No new persistence surface: presence adds zero new Postgres tables, migrations, or
  cascade-delete rules to reason about (a real cost paid recently — see SCRUM-40's FK
  cascade fix — for actually-durable state).
- Reuses two already-proven mechanisms (`ConnectionRegistryService`'s per-instance
  in-memory shape, ADR-0005's Redis-fanout-for-everything model) instead of inventing a
  third pattern, keeping the sync layer's mental model consistent.
- The leading+trailing throttle keeps cursor UI feeling responsive (no perceptible lag
  on the first movement) while still bounding worst-case broadcast volume during
  sustained typing/mouse movement.

**Costs / risks:**

- A server restart or crash silently drops all presence state with no recovery path
  other than clients re-`join`ing — acceptable given §1's reasoning, but worth naming
  explicitly: presence has no equivalent of document content's Postgres-backed
  durability story.
- Cursor position is not CRDT-anchored (§3), so a cursor's displayed position can be
  briefly stale/off by a few characters relative to concurrent remote edits elsewhere in
  the doc. Purely cosmetic, but a real product (vs. this portfolio project) would likely
  need real anchoring eventually.
- `CURSOR_THROTTLE_MS`'s 100ms default is an unvalidated placeholder, same caveat as
  `SNAPSHOT_INTERVAL_MS` — not load-tested.
- The roll-call mechanism (§5) means every instance's newly-subscribing client triggers
  a small burst of Redis traffic (one `roll-call` publish, one `joined` reply per other
  instance with local subscribers) on top of the steady-state fan-out. Not a measured
  problem at this project's scale, but it's an amplification factor a much larger
  deployment with many instances per doc would want to know about.

## Alternatives Considered

- **Dedupe presence by socket/`clientId` instead of `userId`:** rejected — would show a
  phantom extra person in the roster for every extra tab a user opens, which is exactly
  the wrong answer to "who's viewing this doc."
- **Persist presence to Postgres (or Redis as a durable store) for restart survival:**
  rejected — presence has no meaningful state to recover after a restart; every
  connected client re-announces via `join` regardless, which already fully rebuilds the
  roster from scratch. Persisting it would add write load and a table for a value with a
  sub-second natural lifetime.
- **CRDT-anchor cursor positions (e.g. `Y.RelativePosition`):** rejected for this scope
  — real complexity for a cosmetic guarantee `docs/DESIGN.md` doesn't ask for. Revisit if
  cursor fidelity becomes a stated product requirement.
- **Plain fixed-interval cursor sampling (no leading edge):** rejected — makes cursor
  movement feel laggy the instant it starts, since the first update would wait out a
  full interval before the first broadcast.
- **A single Redis channel shared between document updates and presence/cursor:**
  rejected — would couple two traffic types with very different volume/latency profiles
  onto one subscription's message parsing, for no benefit; a second channel is a small,
  well-precedented cost (DESIGN.md §6 already anticipated per-concern channels).
- **Rendered caret overlay in `client/index.html`:** rejected for this harness — not
  feasible in a plain `<textarea>` without a much larger rewrite (contenteditable or
  canvas), and outside this tool's stated charter as a manual-verification harness, not
  the product frontend.
