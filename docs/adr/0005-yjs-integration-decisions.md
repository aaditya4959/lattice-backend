# ADR-0005: Yjs Integration Decisions

**Status:** Accepted
**Date:** 2026-08-10
**Ticket:** SCRUM-34 (LAT-E1B)

## Context

ADR-0004 decided to adopt Yjs directly for the production sync engine rather than
finishing the hand-rolled RGA. That decision was about *whether* to hand-roll; it left
open *how* Yjs actually gets wired into this project's specific stack — a NestJS app
using raw `ws` (ADR-0002), Redis pub/sub for cross-instance fan-out, and Postgres for
persistence.

DESIGN.md §4.2's WebSocket message schema predates all of this — it was written around
the hand-rolled engine's `CRDTOperation` type, which never shipped (the hand-rolled
engine was never networked). Building SyncGateway, DocRegistryService,
RedisFanoutService, and the persistence layer (SCRUM-28 through SCRUM-32) required a
series of concrete decisions that either adapted or diverged from that original sketch.
This ADR is where those decisions get written down in one place, per SCRUM-34.

## Decision

### 1. Wire protocol: flat envelope, hand-rolled dispatch, base64 payloads

`src/sync/protocol.ts` keeps DESIGN.md's message *names* (`join`, `sync-request`,
`sync-response`, `update`, `error`) and its flat `{ type, ... }` JSON envelope, but
replaces the `op: CRDTOperation` / `missingOps: CRDTOperation[]` payloads with
base64-encoded Yjs binary (updates and state vectors). Yjs has no per-operation
representation to put in an `op` field — only opaque binary updates and state vectors.

Binary fields are base64 *strings*, not raw bytes over a binary WS frame — messages
stay JSON text frames throughout, matching DESIGN.md's original convention, trading
~33% payload size for a single consistent, debuggable message shape. Redis messages
(§2 below) follow the same convention for consistency, even though Redis pub/sub could
carry raw binary directly.

Dispatch is hand-rolled, not `@nestjs/websockets`'s `@SubscribeMessage` decorator:
`@nestjs/platform-ws`'s `WsAdapter` requires incoming messages shaped as
`{ event, data }` to route to `@SubscribeMessage` handlers, which would have forced a
different envelope than the one just described. `SyncGateway.handleConnection`
attaches a manual `message` listener and dispatches on `type` itself instead — one
more piece of connection-lifecycle plumbing hand-built rather than delegated, which is
exactly ADR-0002's stated intent for this layer.

`cursor`, `presence`, `ping`/`pong`, and `join`'s `token` field from DESIGN.md's
original sketch are not implemented — no AuthModule yet (no `token` to validate), no
presence ticket yet. Deferred, not silently dropped.

### 2. Fan-out: one path through Redis, not two

`RedisFanoutService` + `ConnectionRegistryService` (SCRUM-29) route *every* broadcast
through Redis publish/subscribe, including delivery to other clients on the same
server instance — there is deliberately no separate direct-local-broadcast path. This
matches DESIGN.md §6's architecture flow literally ("any op broadcast by any
instance... is published to Redis → all subscribed instances receive it and forward to
their locally connected clients") rather than optimizing it into two code paths to keep
in sync. The practical consequence: an instance normally receives its own publishes
back through its own subscription, and `handleRemoteUpdate` skips re-sending only to
the originating *client* (by `clientId`), not by "did this instance publish it" — the
same code path handles same-instance and cross-instance delivery uniformly.

`handleJoin` subscribes to Redis *before* reading the doc's current state for the
`joined` response. This ordering is load-bearing, not incidental: Redis's SUBSCRIBE is
acknowledged only once the subscription is actually active, so subscribing first
guarantees zero gap between "what the snapshot covers" and "what live updates cover"
from that point forward. Reversing this order would open a window where an update
published between the snapshot read and the subscribe call is silently missed.

Two separate Redis connections (publisher, subscriber) are required, not a design
choice — once a Redis connection issues SUBSCRIBE, the protocol restricts it to
pub/sub commands only, so PUBLISH would fail on it.

### 3. Persistence: throttled snapshots, no FK yet, in-flight de-duplication

`SnapshotSchedulerService` (SCRUM-30) implements DESIGN.md §6's "batched/debounced"
snapshot writes as a **throttle**, not a trailing debounce: the first update after a
quiet period schedules a write `intervalMs` later, and further updates before that
timer fires don't push it back out. A literal trailing debounce (reset on every
update) would starve snapshot writes entirely under continuous typing, since the timer
would never get a chance to fire.

`doc_snapshots.doc_id` has no foreign key to `docs.id` — the `docs` table doesn't exist
yet (AuthModule/DocsModule are still empty shells). Tighten this once they land.

`DocRegistryService.getOrCreate` caches in-flight load promises, not just resolved
docs. Without this, two clients joining a never-cached doc at nearly the same time
would each independently create and register their own `Y.Doc`, and whichever finished
loading its Postgres snapshot second would silently clobber the first in the registry
map — dropping any updates already applied to the doc the first caller received.

### 4. Testing: mock at the infra client boundary, not inside application code

Neither `redis.provider.ts` nor `postgres.provider.ts` has a test-mode branch.
Application code always constructs a real `ioredis.Redis` / `pg.Pool`. Tests swap the
underlying module for a mock at Jest's module-loader level instead
(`test/jest.setup.ts`: `jest.mock('ioredis', () => require('ioredis-mock'))` and the
equivalent for `pg` via `pg-mem`'s `createPg()` adapter) — ioredis-mock's own
documented integration pattern, extended to pg-mem for consistency. This keeps
`npm run test:e2e` fully self-contained (no real Redis/Postgres needed) without
application code ever needing to know it might be under test.

The first attempt at this (for Postgres) used a `NODE_ENV`-gated dynamic `import()` of
`ioredis-mock`/`pg-mem`, specifically to keep those devDependencies out of the
production Docker image (`npm ci --omit=dev`). That hit a real Jest limitation — its
default CommonJS runtime can't fulfill dynamic imports without
`--experimental-vm-modules`, a project-wide config change not worth making for this.
The `jest.mock` approach is strictly better anyway: zero test-awareness in application
code, not even a conditional.

**`pg-mem` cannot preserve arbitrary binary data.** Verified directly: a real Yjs
update's bytes, round-tripped through a `pg-mem` `bytea` column, come back corrupted —
0/10 matched byte-for-byte in direct testing, independent of whether the value is
inserted as a `Buffer` parameter or a hex-string literal. The corruption is internal to
pg-mem (a lossy UTF-8-based string representation for `bytea`), not something
insertion technique can work around. Real Postgres has no such issue. Consequence:
persistence tests are split — `persistence.e2e-spec.ts` runs against the mock and
asserts snapshot rows exist with the right shape (no byte decoding, which pg-mem
handles fine); `persistence-restore.e2e-spec.ts` asserts byte-exact restore against a
**real** Postgres (`jest.unmock('pg')` for just that file), skipping — not failing —
when none is reachable via `DATABASE_URL`.

### 5. Client: hand-rolled protocol, not y-websocket

`client/index.html` (SCRUM-32, a manual verification harness, not the product
frontend — see chat history for the "separate repo?" discussion) implements its own
minimal WebSocket provider rather than using the `y-websocket` package. `y-websocket`
has its own wire protocol (binary framing with its own message-type byte scheme), which
is incompatible with the JSON envelope described in §1 above; using it would have meant
either adapting our server to speak *its* protocol or discarding everything in §1.
Hand-rolling ~40 lines of provider code that speaks our own protocol directly was
simpler than reconciling two independently-designed wire formats.

Building and using this real client surfaced a latent gap from SCRUM-28: handler
failures (bad `docId`, DB errors) were logged server-side only, with nothing sent back
to the client — a failure was indistinguishable from "nothing happened." `SyncGateway`
now sends an `error` `ServerMessage` on handler failure in addition to logging it.

## Consequences

**Gains:**
- A concrete, versioned, testable wire protocol (`protocol.ts`) instead of an
  aspirational sketch in a design doc — every field is exercised by at least one e2e
  test.
- One fan-out path (always through Redis) is easier to reason about and test than two
  paths that need to stay behaviorally identical.
- The test suite stays fast and infra-free for everyday development (`npm test`,
  `npm run test:e2e`), while the one assertion that genuinely needs real Postgres gets
  it, rather than either skipping real coverage entirely or forcing infra on every
  contributor.

**Costs / risks:**
- Base64 payload overhead (~33%) on every WS message and Redis publish — a deliberate,
  currently-unmeasured tradeoff for JSON-envelope consistency; worth revisiting if
  bandwidth ever becomes a real constraint (DESIGN.md doesn't currently set one).
- Cross-instance cold-start staleness: a client reconnecting to a *different* instance
  that has never had a local subscriber for that doc can see slightly stale state,
  since Redis pub/sub has no memory and snapshots are throttled, not immediate. Known,
  not yet fixed — flagged during SCRUM-31.
- The schema bootstrap in `PersistenceModule.onModuleInit` is ad hoc
  (`CREATE ... IF NOT EXISTS` plus a manual existence check to work around a pg-mem
  quirk), not a real migration tool. Fine for one table; will need replacing once
  AuthModule/DocsModule add more.
- `persistence-restore.e2e-spec.ts` only proves anything when a real Postgres happens
  to be reachable — its pass/skip status alone doesn't distinguish "verified" from
  "never ran."

## Alternatives Considered

- **`y-websocket` instead of a hand-rolled client provider:** rejected — incompatible
  wire protocol with what SyncGateway speaks, and reconciling the two would have meant
  giving up the protocol decisions in §1, which exist for good reasons (JSON-envelope
  consistency with the rest of the system, ADR-0002's hand-build-the-mechanics intent).
- **`@SubscribeMessage`-based dispatch:** rejected — requires an `{ event, data }`
  envelope incompatible with DESIGN.md's flat `{ type, ... }` schema.
- **Separate local-broadcast and cross-instance-broadcast code paths:** rejected — two
  paths that must stay behaviorally identical is a maintenance and correctness risk for
  no real benefit; DESIGN.md §6 already describes a single Redis-mediated flow.
- **Requiring real Redis/Postgres for the full test suite:** rejected, consistent with
  this project's testing philosophy so far — would make `npm test`/`npm run test:e2e`
  depend on infra for every contributor and CI run, for tests that (mostly) don't need
  to touch real infra behavior to prove their point.
- **Trailing debounce for snapshot writes:** rejected — starves writes indefinitely
  under continuous editing activity, the opposite of what a "don't lose data" mechanism
  should do.
