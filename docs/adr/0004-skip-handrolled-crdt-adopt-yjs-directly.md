# ADR-0004: Skip Remaining Hand-Rolled CRDT Work, Adopt Yjs Directly

**Status:** Accepted
**Date:** 2026-08-09
**Ticket:** LAT-E1B
**Supersedes:** ADR-0001

## Context

ADR-0001 planned a two-phase CRDT strategy: hand-roll a simplified RGA first (Phase 1,
for learning) and then replace it with Yjs for the production networked app (Phase 2).

Phase 1 is complete through LAT-13 (Jira: SCRUM-19): unique operation IDs and logical
clocks (`src/crdt/clock.ts`), reference-based positioning and same-origin tie-breaking
(`src/crdt/rga.ts`), and the conceptual model documented in `docs/notes/rga-summary.md`.
That work already delivers the core learning goal ADR-0001 was written to protect —
first-hand understanding of unique IDs, reference-based positioning, tombstones as a
concept, and deterministic tie-breaking — backed by tests (`clock.spec.ts`,
`rga.spec.ts`) that prove uniqueness, total ordering, and correct insert behavior
including the documented same-origin tie-break simplification.

What remained under LAT-E1 (LAT-14 through LAT-18) was hand-rolling tombstone-based
delete, remote-op merge logic, a fuzz/property-based convergence proof, a performance
benchmark, and a closing ADR. Each of these teaches real CRDT mechanics, but the
project's dual goal — deep learning *and* a real, deployable product — has shifted
priority: the marginal learning return on hand-rolling delete/merge/convergence proofs a
second time (Yjs will need to be learned at its own depth regardless, since it's the
production dependency) is smaller than the cost of the time it takes, and it directly
delays getting a working, usable product in front of real users, which is itself a
stated project goal, not a secondary one.

## Decision

Adopt Yjs directly for the production sync engine, starting immediately, rather than
finishing the hand-rolled delete/merge/convergence/benchmark work first.

- `src/crdt/` is retained in the repository as-is — not deleted, not migrated. It stands
  as a documented, tested reference artifact demonstrating hand-rolled CRDT mechanics
  (unique IDs, reference-based positioning, tie-breaking), independent of the shipped
  product.
- LAT-14 through LAT-18 (remaining hand-rolled delete/merge/convergence/benchmark/ADR
  tickets) are closed as won't-do, not deleted or silently dropped — see ticket comments
  for the same reasoning captured here.
- A new epic, LAT-E1B ("Production Sync Engine — Yjs Integration"), replaces LAT-E1's
  remaining scope with direct Yjs adoption: install Yjs, design the doc schema, wire the
  `ws`-based NestJS gateway (per ADR-0002, unchanged) to Yjs's sync protocol, add Redis
  fan-out and Postgres snapshotting for Yjs updates, implement resync via Yjs state
  vectors, and build a minimal client to prove multi-client convergence end-to-end.

## Consequences

**Gains:**
- Faster path to a real, working, deployable product — the project's other stated goal,
  alongside learning.
- Yjs handles edge cases the hand-rolled v1 never reached: rich text structures,
  undo/redo, the awareness protocol (presence/cursors), and a mature binary encoding for
  compact updates and snapshots — all things the project would have needed to build or
  work around by hand otherwise.
- No wasted work: `src/crdt/` remains a complete, tested, documented interview artifact
  covering the mechanics that were fully implemented (IDs, positioning, tie-breaking),
  and ADR-0001 + `docs/notes/rga-summary.md` document the reasoning and mental model
  regardless of what ships to production.

**Costs / risks:**
- Less first-hand implementation depth specifically on tombstone deletion, remote-op
  merge, and convergence proofs — the project will *use* Yjs's versions of these rather
  than building and testing its own. Mitigated by the fact that Yjs is open source; its
  internals remain available to study later if deeper interview prep on those specific
  mechanics is needed, and the existing hand-rolled insert/ID work already establishes
  the foundational mental model those mechanics build on.
- The project now carries a "why did you stop halfway" question in interview
  conversation — mitigated by this ADR and the ticket-closure comments being explicit,
  honest, and reasoned rather than silent, which is itself a reasonable engineering
  narrative (recognizing diminishing returns and re-scoping is a real skill).

## Alternatives Considered

- **Finish LAT-14 through LAT-18 as originally scoped, then migrate to Yjs:** rejected —
  this is ADR-0001's original plan. Rejected now because the highest-value learning
  (IDs, positioning, tie-breaking) is already banked, and the remaining hand-rolled work
  would be substantially thrown away in favor of Yjs's implementations of the same
  concepts, for a shrinking marginal learning return relative to its time cost.
- **Drop CRDTs entirely, use OT or a simpler last-write-wins model:** rejected — CRDTs
  remain the correct approach for the project's no-central-coordinator, offline-friendly
  goals (see `docs/DESIGN.md` §7); this ADR only changes *how* the CRDT layer is built,
  not whether one is needed.
- **Delete `src/crdt/` since it won't be used in production:** rejected — the code and
  its tests are a genuine, verified learning artifact and interview talking point; the
  cost of keeping it in the repo (a self-contained `src/crdt/` module, not wired into
  the production path) is negligible.
