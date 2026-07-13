# Lattice — Design Doc (RFC)

**Author:** Aaditya
**Date:** 2026-07-14
**Status:** Draft
**Ticket:** LAT-1

---

## 1. Problem Statement

Real-time collaborative editing (Google Docs, Figma, Notion) requires multiple users to
edit shared state concurrently without conflicts, data loss, or a central lock forcing
serialized writes. Naive approaches (last-write-wins, pessimistic locking) either lose
data or destroy the "multiplayer" experience users expect.

Lattice is a real-time collaborative text editor that uses **Conflict-free Replicated
Data Types (CRDTs)** to guarantee that concurrent edits from any number of clients
always converge to the same final document state, without a central coordinator
resolving conflicts — and works offline, syncing cleanly on reconnect.

This project exists to (a) produce a genuinely useful, narrow collaborative editing
tool with real users, and (b) build deep, defensible expertise in distributed systems
concepts — CRDTs, WebSocket fan-out at scale, eventual consistency, and offline-first
sync — that map directly to system design interview topics at both HFT/quant firms and
top product companies.

**Target initial use case:** shared study/interview-prep notes for small groups (2–10
people per doc) — narrow enough to launch and get real usage quickly, general enough to
expand later.

---

## 2. Goals / Non-Goals

### Goals (v1)
- Real-time multi-user text editing with sub-200ms perceived sync latency on a single
  region deployment
- Correct convergence under concurrent edits, including out-of-order delivery
- Offline editing with clean resync on reconnect (no data loss, no duplicate ops)
- Live presence — see who else is viewing/editing, live cursor positions
- Horizontal scalability — multiple server instances handling the same document via
  Redis pub/sub fan-out, not a single-server bottleneck
- Persistence with efficient snapshotting (no full op-log replay on every doc load)

### Non-Goals (v1)
- Rich media embeds (images, tables, embeds) — plain/rich text only
- Fine-grained permissions (view-only roles, per-paragraph locking) — all editors have
  full write access in v1
- Version history / time-travel UI (the data model will support it later, but no UI in v1)
- Mobile native apps — web only
- Multi-region active-active replication — single-region deployment for v1, multi-region
  is a documented future direction, not built now

---

## 3. High-Level Architecture

```
                         ┌─────────────────┐
                         │   Client (Web)   │
                         │  Yjs CRDT doc    │
                         │  WS client       │
                         └────────┬─────────┘
                                  │ WebSocket
                                  ▼
                    ┌─────────────────────────┐
                    │   Load Balancer (ALB)    │
                    └────────┬───────┬─────────┘
                              │       │
                 ┌────────────┘       └────────────┐
                 ▼                                  ▼
       ┌───────────────────┐              ┌───────────────────┐
       │ NestJS Instance A  │              │ NestJS Instance B  │
       │  - Auth (REST)     │              │  - Auth (REST)     │
       │  - Sync Gateway(WS)│◄────────────►│  - Sync Gateway(WS)│
       └─────────┬──────────┘   Redis      └─────────┬──────────┘
                 │            Pub/Sub                │
                 │         (fan-out ops)              │
                 ▼                                    ▼
       ┌─────────────────────────────────────────────────┐
       │                Redis (pub/sub + cache)            │
       └─────────────────────────────────────────────────┘
                 │
                 ▼
       ┌─────────────────────────────────────────────────┐
       │           Postgres (snapshots + metadata)          │
       └─────────────────────────────────────────────────┘
```

**Flow:** client connects via WS to any server instance behind the ALB → instance
authenticates the connection → subscribes to that doc's Redis pub/sub channel → any op
broadcast by any instance (from any client) is published to Redis → all subscribed
instances receive it and forward to their locally connected clients for that doc. This
is what allows horizontal scaling — no client needs to be "stuck" on the instance
holding the canonical doc state, because there is no single canonical in-memory copy;
convergence is guaranteed by the CRDT itself.

---

## 4. API Contracts

### 4.1 REST Endpoints (NestJS, `AuthModule` / `DocsModule`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/register` | Create account |
| `POST` | `/auth/login` | Returns JWT |
| `GET` | `/docs` | List docs user has access to |
| `POST` | `/docs` | Create new doc |
| `GET` | `/docs/:id` | Get doc metadata + latest snapshot |
| `DELETE` | `/docs/:id` | Delete doc (owner only) |
| `POST` | `/docs/:id/invite` | Invite collaborator by email |

### 4.2 WebSocket Message Schema (`SyncModule`, raw `ws` gateway)

All messages are JSON with a `type` discriminator:

```typescript
// Client → Server
type ClientMessage =
  | { type: 'join'; docId: string; token: string }
  | { type: 'op'; docId: string; op: CRDTOperation; clientOpId: string }
  | { type: 'cursor'; docId: string; position: number }
  | { type: 'sync-request'; docId: string; stateVector: Uint8Array } // reconnect resync
  | { type: 'ping' };

// Server → Client
type ServerMessage =
  | { type: 'joined'; docId: string; initialState: Uint8Array }
  | { type: 'op'; docId: string; op: CRDTOperation; fromClientId: string }
  | { type: 'presence'; docId: string; users: PresenceInfo[] }
  | { type: 'sync-response'; docId: string; missingOps: CRDTOperation[] }
  | { type: 'ack'; clientOpId: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };
```

Key design points:
- `clientOpId` on every client op enables **idempotent** op application — if a
  reconnect causes a resend, the server/other clients can dedupe safely.
- `sync-request` with a **state vector** (not full history) is what makes reconnect
  sync efficient — the server only sends ops the client is missing, not the entire doc
  history.

---

## 5. Data Model

**Postgres tables:**

```
docs
  id            uuid PK
  owner_id      uuid FK -> users.id
  title         text
  created_at    timestamptz
  updated_at    timestamptz

doc_snapshots
  id            uuid PK
  doc_id        uuid FK -> docs.id
  state         bytea        -- serialized Yjs doc state
  state_vector  bytea        -- for resync diffing
  created_at    timestamptz

doc_collaborators
  doc_id        uuid FK -> docs.id
  user_id       uuid FK -> users.id
  role          text          -- 'owner' | 'editor' (view-only reserved for later)
```

**Why snapshots, not a full op-log table:** replaying every op since doc creation on
every load doesn't scale. Instead, periodically (e.g. every N ops or every 30s of
activity) collapse the CRDT state into a snapshot + state vector. On load, client gets
the latest snapshot and only needs ops newer than that snapshot's state vector.

---

## 6. Scaling Considerations

- **Connection fan-out:** Redis pub/sub, one channel per doc (`doc:<id>`). Each server
  instance subscribes only to channels with at least one locally connected client, and
  unsubscribes when the last local client for a doc disconnects — avoids unbounded
  subscription growth on instances with no active interest in a doc.
- **Hot docs:** a doc with many concurrent editors (e.g. 50+) concentrates load on one
  Redis channel. Acceptable for v1 target scale (2–10 users/doc); documented as a known
  limitation, not solved now.
- **Snapshot writes:** batched/debounced (not on every single op) to avoid hammering
  Postgres under high edit frequency.
- **Horizontal server scaling:** stateless NestJS instances behind ALB, autoscaling on
  CPU/connection count via ECS Fargate.

---

## 7. Alternatives Considered

- **Operational Transform (OT) instead of CRDT** — rejected. OT requires a central
  server to sequence/transform ops (how Google Docs classically worked), which
  reintroduces a coordination bottleneck we're specifically trying to avoid, and is
  significantly harder to implement correctly than CRDTs for a solo project.
- **Socket.io instead of raw `ws`** — rejected; see ADR-0002. Abstracts away the exact
  connection-lifecycle mechanics this project is meant to teach.
- **Single-server (no Redis fan-out) for v1** — rejected. Would work for a demo but
  removes the horizontal-scaling learning goal entirely, which is a core objective of
  this project, not an afterthought.

---

## 8. Open Questions

- Do we need per-op encryption at rest, or is TLS-in-transit + Postgres encryption
  sufficient for v1? *(Leaning: sufficient for v1, revisit if handling sensitive docs.)*
- What's the right debounce interval for snapshotting — needs empirical tuning once
  load-testing (k6) is in place.
- Multi-region: out of scope for v1, but worth a short follow-up ADR once single-region
  is stable, since it's a natural "part 2" story for the resume.