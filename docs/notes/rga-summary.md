# RGA (Replicated Growable Array) — Summary Notes

**Ticket:** LAT-10
**Purpose:** Refresher notes on how RGA works, in plain terms, before implementing it.

---

## 1. The problem it solves

Plain arrays use numeric indices ("insert at position 5"). But when two clients edit
concurrently, position 5 means different things to each of them by the time their edits
meet — one edit shifts everything after it, so the other edit's "position 5" is now
wrong. Array indices are not stable identities across concurrent edits.

**Fix:** give every element a permanent, unique identity that never changes, and define
positions *relative to a neighbor's identity*, not a numeric index.

## 2. Core structure: a linked list of permanently-identified nodes

Think linked list, not array. Every character/element is a node with:
- A **unique ID** — pair of `(clientId, counter)`. E.g. Alice's 5th ever edit = `(Alice, 5)`.
- A **reference to the node it comes after** — "I'm inserted right after node `(Bob, 2)`,"
  not "I'm at position 5."

This is the core mental shift: **position is relative to a neighbor's ID, not an index.**

## 3. Unique ID generation (logical clocks)

- Each client keeps its own incrementing counter (Lamport-style clock).
- ID = `(clientId, counter)`. Two clients never collide because client IDs differ.
- IDs are totally orderable: compare counter first, break ties with client ID (or
  vice versa — pick one consistent rule and apply it everywhere).

## 4. Concurrent inserts at the same position — tie-breaking

If Alice and Bob both insert "right after H" at the same moment (before seeing each
other's edit), there's no natural ordering between their two operations — they're
**concurrent**. RGA resolves this with a deterministic tie-break rule: compare the
unique operation IDs, and whichever is "greater" gets placed closer to the reference
node.

**Key insight:** every replica applies the exact same rule to the exact same operations,
so regardless of the order operations *arrive* in, every replica computes the identical
final arrangement — without needing to talk to each other in real time.

## 5. Deletion — tombstones, never physical removal

If a delete physically removed a node, any other operation that referenced that node's
ID (e.g. "insert after it") would break — pointing at something that no longer exists.

**Fix:** deletion just marks a node as a **tombstone** (logically deleted, but still
present in the underlying structure). Rendering the visible document simply filters out
tombstoned nodes. Structure integrity is preserved; the user just never sees it.

## 6. Why this guarantees convergence

The merge operation is designed to be:
- **Commutative** — applying op A then B gives the same result as B then A
- **Associative** — grouping doesn't matter: (A then B) then C = A then (B then C)
- **Idempotent** — applying the same op twice (e.g. a network resend) has no extra
  effect, because each op has a unique ID you can check against "already applied" ops

Together these three properties mean: **any set of operations, merged in any order,
converges to the identical final document on every replica.** This structure is
formally a **join-semilattice** — literally where the project name "Lattice" comes from.

## 7. Causal ordering vs. tie-breaking — don't confuse these

- **Concurrent operations**: neither replica knew about the other's op when it made its
  own. Resolved via the ID tie-break rule (section 4).
- **Causally dependent operations**: one replica saw an op, then created a new op that
  depends on it (e.g. "insert after the node Bob just made"). RGA gets this correctness
  *for free* — since inserts reference a specific prior node ID (not a timestamp), an
  operation referencing a not-yet-seen ID simply can't be applied until that ID exists
  locally. The reference structure itself enforces causal order; no separate mechanism
  needed.
- Lamport clocks only give a total order for *tie-breaking concurrent ops* — they are
  not what establishes causal correctness. This is a common point of confusion worth
  remembering precisely.

## 8. Known weak point: performance

Naive RGA requires walking the linked list to find "the node after ID X" — O(n) per
operation. For large documents, every keystroke could scan thousands of nodes.
Production libraries (e.g. Yjs) solve this with smarter internal structures (balanced
trees, run-length encoding of consecutive same-client inserts) to get much better than
O(n). This is the documented justification (ADR-0001) for hand-rolling RGA to learn it,
then switching to Yjs for the actual production app.

## 9. One-breath summary (interview-ready)

> An RGA represents a sequence as a set of uniquely-identified, immutable operations
> rather than array positions. Inserts reference the ID of their left neighbor instead
> of a numeric index, so they remain valid regardless of concurrent inserts/deletes
> elsewhere. Deletes are tombstones, not removals, preserving referential integrity for
> any operation that already pointed at that node. Concurrent inserts at the same
> position are resolved by a deterministic tie-break over unique operation IDs, so every
> replica computes the identical order without real-time coordination. This makes the
> merge commutative, associative, and idempotent — guaranteeing convergence regardless
> of delivery order, a property formally known as a join-semilattice.

## 10. Terms to have cold for interviews

| Term | One-line meaning |
|---|---|
| CRDT | Data type where concurrent replicas always converge without central coordination |
| RGA | A CRDT for ordered sequences (text), using reference-based positions |
| Tombstone | A logically-deleted node kept in structure for referential integrity |
| Lamport clock | Per-client counter used to generate unique, orderable operation IDs |
| Commutative | Order of applying operations doesn't affect the final result |
| Idempotent | Applying the same operation more than once has no additional effect |
| Join-semilattice | Mathematical structure guaranteeing a unique "merge" result from any op set |
| Causal order | The "must happen before" relationship between dependent operations |