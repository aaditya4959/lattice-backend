# CLAUDE.md — Project Context for Claude Code

This file gives Claude Code the context needed to continue work on Lattice without
re-explaining the project from scratch. Read this fully before making changes.

## Project Overview

**Lattice** is a real-time collaborative text editor built as a portfolio/learning
project, using CRDTs (Conflict-free Replicated Data Types) to guarantee that concurrent
edits from multiple clients converge without a central coordinator. Built with proper
production-dev practices (RFC, ADRs, sprints, CI/CD) specifically to serve as a strong
system-design resume artifact and interview talking point.

Full design doc: `docs/DESIGN.md`
Jira project key: `LAT` (epics: `LAT-E0` through `LAT-E5`)

## Tech Stack (with reasoning — see ADRs for full detail)

- **Framework**: NestJS (ADR-0003) — chosen for DI/testability structure + prior team
  familiarity, not raw throughput
- **Real-time transport**: raw `ws` library wrapped in a custom NestJS WebSocket
  gateway (ADR-0002) — deliberately NOT Socket.IO, because the project's goal is to
  learn connection lifecycle/reconnect mechanics firsthand, not abstract them away
- **CRDT approach**: hand-rolled RGA (Replicated Growable Array) for learning (Phase 1),
  with a planned swap to Yjs for the production networked app (Phase 2+) — see ADR-0001
- **Cross-instance scaling**: Redis pub/sub fan-out (one channel per doc)
- **Persistence**: Postgres — snapshots + state vectors, not full op-log replay (see
  `docs/DESIGN.md` §5)
- **Local dev**: Docker Compose (app + Postgres + Redis)
- **Language**: TypeScript, strict mode enabled

## Key Documents (read these for full reasoning, don't re-derive it)

- `docs/DESIGN.md` — the RFC: problem statement, architecture, API contracts, data
  model, scaling considerations
- `docs/adr/0001-crdt-approach.md` — why hand-roll RGA first, then Yjs
- `docs/adr/0002-transport-layer.md` — why raw `ws` over Socket.IO
- `docs/adr/0003-framework-choice.md` — why NestJS
- `docs/notes/rga-summary.md` — conceptual primer on how RGA works (unique IDs,
  reference-based positioning, tombstones, tie-breaking, causal order vs. Lamport
  clocks, formal CRDT terminology). Read this before touching `src/crdt/`.

## CRDT Core Concepts (quick reference — full detail in rga-summary.md)

- Every operation has a unique `OperationId = { clientId, counter }` (Lamport-style
  logical clock; see `src/crdt/clock.ts`)
- Inserts reference a `leftOrigin` (the ID of the node they're inserted after), not a
  numeric array index
- Concurrent inserts at the same origin are tie-broken deterministically: higher
  `OperationId` (per `compareOperationId`) sorts closer to the origin
- Deletes are tombstones (`isDeleted: true`), never physical removal — preserves
  referential integrity for any op that already referenced that node
- Correctness relies on the merge being commutative, associative, and idempotent
  (formally: a join-semilattice) — this is why the project is named Lattice

## Current Implementation State

**Completed (Sprint 1 — `LAT-E0`, all done):**
- Repo scaffolding, branch protection, PR template
- CI pipeline (`.github/workflows/main.yml`): lint, typecheck, test, build — verified
  both pass and fail cases block merge correctly
- `Dockerfile` (multi-stage: builder + production) and `docker-compose.yml` (app +
  Postgres + Redis) — confirmed working locally
- NestJS scaffolded with strict TS, module skeleton (`AuthModule`, `DocsModule`,
  `SyncModule`, `PersistenceModule` — currently empty shells)
- Jest configured and CI-enforced

**`LAT-E1` (Core CRDT Engine) — closed 2026-08-09, superseded by ADR-0004:**
- ✅ `LAT-10`: RGA research + `docs/notes/rga-summary.md` written
- ✅ `LAT-11`: `src/crdt/types.ts` — `OperationId`, `InsertOp`, `DeleteOp`,
  `CRDTOperation` union, `ROOT_ORIGIN` sentinel
- ✅ `LAT-12`: `src/crdt/clock.ts` — `LogicalClock` class, `compareOperationId`,
  `operationIdEquals`, with `clock.spec.ts` proving uniqueness + total ordering
- ✅ `LAT-13`: `src/crdt/rga.ts` — `RGA` class with `insert()` implemented (linked-list
  structure, reference-based positioning, sentinel root node, idempotency check), with
  `rga.spec.ts` covering sequential typing, mid-document insertion, and the same-origin
  tie-break behavior. **Known documented simplification**: insert resolves position by
  direct ID comparison among immediate siblings — does not implement YATA's dual-origin
  refinement. This is intentional per ADR-0001, not a bug to silently fix.
  `src/crdt/` is **retained in the repo as a documented, tested reference artifact** —
  it is not wired into production and not deleted.
- ⛔ `LAT-14` (delete/tombstones), `LAT-15` (merge/apply-remote-op), `LAT-16`
  (convergence fuzz test), `LAT-17` (performance benchmark), `LAT-18` (closing ADR) —
  closed **won't-do**. The project pivoted to adopting Yjs directly for the production
  sync engine rather than finishing the hand-rolled implementation. See
  `docs/adr/0004-skip-handrolled-crdt-adopt-yjs-directly.md` for full reasoning.
  `docs/adr/0001-crdt-approach.md` is now marked superseded by ADR-0004.

**`LAT-E1B` (Production Sync Engine: Yjs Integration) — closed 2026-08-10, all nine tickets done:**
- ✅ Yjs + `lib0` installed; `src/sync/yjs.smoke.spec.ts` proves the basic roundtrip
- ✅ Doc schema: one `Y.Text` per doc (`src/sync/doc-schema.ts`), per `docs/DESIGN.md`'s
  non-goals — no rich structures yet
- ✅ `SyncGateway` (`src/sync/sync.gateway.ts`) — raw `ws` per ADR-0002, hand-rolled
  message dispatch (not `@SubscribeMessage`, see ADR-0005), state vector exchange +
  update broadcasting
- ✅ `ConnectionRegistryService` + `RedisFanoutService` — per-doc Redis pub/sub fan-out
  across instances (`docs/DESIGN.md` §6); one unified broadcast path, not a separate
  local-vs-cross-instance split (ADR-0005 §2)
- ✅ `PersistenceModule` — throttled Postgres snapshotting (`SnapshotSchedulerService`),
  state-vector-based diffing for resync (`doc_snapshots`, `docs/DESIGN.md` §5). No FK to
  `docs.id` yet (table doesn't exist)
- ✅ Reconnect/resync protocol — `sync-request`/`sync-response`, proven to actually diff
  (not just converge) in `test/reconnect.e2e-spec.ts`
- ✅ `client/index.html` — minimal manual-verification harness (not the product
  frontend; stays in this repo, no separate frontend repo), hand-rolled protocol
  provider, manually verified working across tabs
- ✅ `test/convergence.e2e-spec.ts` — concurrent-edit convergence including a
  deterministic out-of-order-application proof
- ✅ `docs/adr/0005-yjs-integration-decisions.md` — full writeup of the integration
  decisions above

Known gap, documented not fixed: a client reconnecting to a *different* server instance
with no prior local subscriber for that doc can see slightly stale state (Redis pub/sub
has no memory; snapshots are throttled, not immediate) — see ADR-0005's Consequences.

**In progress (active sprint — `LAT-E2`, repurposed: Accounts & Documents — Auth + REST API):**
Original `LAT-E2` scope ("real-time networking layer") is done, absorbed into
`LAT-E1B` — this slot now covers what DESIGN.md §4.1/§5 always specified but was never
built: there is currently no `docs`/`users` table and `SyncGateway` accepts any
`docId` from any client with zero authorization.
- ✅ `SCRUM-36`: `users`/`docs`/`doc_collaborators` schema bootstrap; FK from
  `doc_snapshots.doc_id` → `docs.id` (missing since SCRUM-30)
- ✅ `SCRUM-37`: `POST /auth/register` / `POST /auth/login` — bcrypt password hashing +
  JWT (`AuthModule`, hand-rolled, no Passport — see `src/auth/`)
- ✅ `SCRUM-38`: `JwtAuthGuard` for REST routes + token validation on `join`
  (DESIGN.md's `join.token` field, deferred since SCRUM-28 — no AuthModule existed yet)
- ✅ `SCRUM-39`: `DocsModule`: `POST /docs` (create), `GET /docs` (list, owner +
  collaborator access)
- ✅ `SCRUM-40`: `DocsModule`: `GET /docs/:id` (metadata + `latestSnapshotAt`),
  `DELETE /docs/:id` (owner-only), `POST /docs/:id/invite` (owner-only, by email).
  Found and fixed a real bug along the way: `doc_snapshots`/`doc_collaborators` had no
  `ON DELETE CASCADE` on their `doc_id` FK, so deleting any doc that actually had
  snapshots or collaborators would have failed. `PersistenceModule`'s FK bootstrap is
  now self-healing (`DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` on every boot,
  see `ensureForeignKey()`) rather than create-once-and-skip, so schema.ts constraint
  changes propagate to existing databases automatically.
- ✅ `SCRUM-41`: `SyncGateway.handleJoin` now checks `DocsService.findAccessible()`
  after token verification — a valid token no longer implies access to an arbitrary
  `docId`. No access (or a `docId` that isn't a real `docs` row at all — same response
  either way, no enumeration) rejects with `{type:'error', code:'forbidden'}`, a new
  code distinct from `unauthorized` (bad/missing token). This closes the original
  epic's zero-authorization gap: a client can no longer implicitly create/join any doc
  it invents — `docId` must already exist via `POST /docs`. Updated
  `sync`/`sync-fanout`/`reconnect`/`convergence`/`persistence`/`persistence-restore`
  e2e specs to register a real user and own (or get invited to) a real doc before
  joining, rather than a bare signed token; `client/index.html` now requires `?doc=`
  the same way it already required `?token=`.
- ✅ `SCRUM-42`: `test/full-lifecycle.e2e-spec.ts` — one continuous scenario (not
  several independent `it()`s, since each step depends causally on the last) proving
  register → login → create doc → join via WS with a token → edit → list docs →
  invite a collaborator → the collaborator can also list and join, all compose
  correctly together rather than just passing in isolation.
- ✅ `SCRUM-43`: `docs/adr/0006-auth-strategy.md` — JWT-vs-sessions, bcrypt-vs-Argon2id,
  and why `join`'s token lives in an application-level message rather than a header or
  query param (browsers can't set custom headers on a WS handshake; query params leak
  into logs).

`LAT-E2` is now complete — all nine tickets (SCRUM-36 through SCRUM-43) done.

`LAT-E3` / `LAT-E4` (horizontal scaling, persistence & offline sync) — same as before,
already absorbed into `LAT-E1B`'s Redis fan-out and Postgres snapshotting. No separate
work planned under those numbers.

**Not started:**
- `LAT-E5`: Product polish & launch

## Conventions Established So Far

- **Git**: trunk-based, `main` protected (PR + passing CI required, no bypass),
  conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`)
- **Every non-trivial technical decision gets an ADR** in `docs/adr/`, numbered
  sequentially, format: Context → Decision → Consequences → Alternatives Considered
- **Testing**: Jest. Acceptance criteria on CRDT tickets specifically require proof of
  correctness (convergence, ordering, idempotency), not just "code runs" — tests should
  reflect that bar, including edge cases and documented-behavior tests, not just happy
  paths
- **Code comments**: files under `src/crdt/` carry substantial doc-comments explaining
  *why*, with references back to `docs/notes/rga-summary.md` section numbers and the
  relevant ADR — maintain this pattern, it's intentional (this codebase doubles as an
  interview-prep artifact, not just working code)
- **Sprint structure**: 1-week sprints, tracked in Jira (`LAT` project), GitHub Projects
  kanban board, tickets sized S/M/L

## How to Work With Me on This Project

- When implementing a new CRDT ticket, check `docs/notes/rga-summary.md` for the
  relevant concept before writing code — don't deviate from the established mental
  model without flagging why
- When making a non-trivial technical choice, propose it as a new ADR
  (`docs/adr/000X-title.md`) following the existing format
- Keep the "hand-roll to learn, then production library" philosophy (ADR-0001) — don't
  silently pull in Yjs or another CRDT library mid-implementation without discussing it
  first, since fully implementing the algorithm by hand is the point of `LAT-E1`
- Maintain the doc-comment density already established in `src/crdt/*.ts` — this
  codebase is explicitly meant to be walkthrough-ready for interviews