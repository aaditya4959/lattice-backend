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

**In progress (Sprint 2 — `LAT-E1`, Core CRDT Engine):**
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
- ⏳ **`LAT-14` (NEXT UP)**: implement delete as tombstones — mark node `isDeleted =
  true`, exclude from `toArray()`/`toString()` output. Node shape already has
  `isDeleted` field ready for this.
- ⏳ `LAT-15`: merge/apply-remote-op logic — apply an operation from another client
  regardless of arrival order
- ⏳ `LAT-16`: property-based/fuzz convergence test (fast-check) — the centerpiece
  correctness proof for the whole engine
- ⏳ `LAT-17`: performance benchmark (100/1k/10k ops) — document results in
  `docs/notes/rga-benchmark.md`, expected to reveal O(n) lookup cost, justifying the
  Yjs migration per ADR-0001
- ⏳ `LAT-18`: ADR-0004 — hand-rolled CRDT learnings + Yjs migration plan

**Not started:**
- `LAT-E2`: Real-time networking layer (WebSocket gateway, reconnect/resync protocol)
- `LAT-E3`: Horizontal scaling & Redis fan-out
- `LAT-E4`: Persistence & offline sync
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