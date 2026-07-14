# ADR-0001: CRDT Approach — Hand-Roll First, Then Adopt Yjs

**Status:** Accepted
**Date:** 2026-07-14
**Ticket:** LAT-4

## Context

Lattice's core requirement is that concurrent edits from multiple clients converge to
the same final document state without a central server resolving conflicts. This is
the textbook use case for a CRDT (Conflict-free Replicated Data Type).

Production-grade CRDT libraries exist (Yjs being the most mature in the JS ecosystem)
and could be adopted directly. However, a primary goal of this project (alongside
shipping a usable product) is to build genuine, defensible understanding of how CRDTs
work internally — not just how to call a library's API. If Yjs is used from day one,
it's easy to end up with a working app but a shallow understanding of *why* it works,
which undermines the project's value as interview preparation for system design rounds.

## Decision

Build the CRDT engine in two phases:

- **Phase 1 (learning):** Hand-roll a basic CRDT (a simplified RGA — Replicated Growable
  Array — for sequence/text editing) from scratch, applied to a single text field, with
  no networking. Goal: prove convergence under concurrent, out-of-order operations with
  hand-written tests, and be able to explain the algorithm's mechanics unaided.
- **Phase 2 onward (production):** Replace the hand-rolled implementation with Yjs for
  the actual networked, multi-user application. Yjs is battle-tested, handles edge cases
  (e.g. rich text structures, undo/redo, awareness protocol) that a hand-rolled v1 won't,
  and is what a real production system would reasonably use.

## Consequences

**Gains:**
- Deep, first-hand understanding of CRDT mechanics (tombstones, unique operation IDs,
  causal ordering, convergence proofs) instead of black-box library usage
- Concrete artifact (the hand-rolled implementation + its convergence tests) usable as
  an interview talking point independent of the final product
- Production app still benefits from Yjs's maturity and edge-case handling, so the
  shipped product isn't compromised by a homegrown implementation's rough edges

**Costs / risks:**
- Extra time spent in Phase 1 building something that gets replaced, rather than going
  straight to Yjs and shipping faster
- Risk of the hand-rolled implementation having subtle bugs if not tested rigorously —
  mitigated by property-based/fuzz testing on concurrent op sequences before moving on
- Two mental models to reconcile (own RGA vs Yjs's internal approach) — acceptable
  tradeoff since the goal is comparative understanding, not code reuse between the two

## Alternatives Considered

- **Adopt Yjs from day one:** rejected for this phase — fastest path to a working
  product, but skips the core learning objective this project is built around.
- **Operational Transform (OT) instead of CRDT:** rejected — requires a central
  sequencing server, reintroducing the coordination bottleneck this project is designed
  to avoid, and is harder to implement correctly than a CRDT for a solo effort.