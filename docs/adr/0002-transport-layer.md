# ADR-0002: Use Raw `ws` Instead of Socket.IO for the Sync Gateway

**Status:** Accepted
**Date:** 2026-07-14
**Ticket:** LAT-5

## Context

Lattice needs a real-time transport layer to broadcast CRDT operations, cursor
positions, and presence updates between connected clients. Socket.IO is the familiar
default choice (used previously on the Tabble project), offering built-in room
management, automatic reconnection, and fallback transports out of the box.

However, this project's explicit goal is to build deep understanding of the connection
lifecycle mechanics that underlie real-time collaborative systems: connection registry
management, heartbeat/liveness detection, and — most importantly — the reconnect/resync
protocol (a client reconnecting after a drop must efficiently receive only the ops it
missed, not the full document history). Socket.IO abstracts most of this away by
design, which is valuable for typical production use but counterproductive for the
learning objective here.

## Decision

Use the raw `ws` library, wrapped in a custom NestJS WebSocket gateway (via NestJS's
`WsAdapter`), for the sync transport layer.

This means hand-building:
- A connection registry mapping active sockets to the document(s) they're subscribed to
- Heartbeat/ping-pong logic to detect and clean up dead connections
- A reconnect/resync protocol where the client sends its last-known state vector and
  the server responds with only the missing operations
- Redis pub/sub wiring for fan-out across multiple server instances (see architecture
  in `docs/DESIGN.md`)

## Consequences

**Gains:**
- Forces implementation of the exact mechanics (connection lifecycle, resync protocol,
  cross-instance fan-out) that are the actual learning target of this project
- Fewer abstraction layers between the app code and the raw protocol, making it easier
  to reason about and debug scaling behavior under load testing
- No unused surface area (Socket.IO's fallback transports like long-polling aren't
  needed since all target browsers support native WebSockets)

**Costs / risks:**
- More boilerplate than Socket.IO's out-of-the-box room management and reconnection
  handling — slower initial development
- Higher risk of subtle bugs in hand-rolled reconnect/dedup logic (mitigated via
  integration tests simulating disconnect/reconnect with concurrent edits, per the
  testing strategy in `docs/DESIGN.md`)
- No automatic fallback transport if native WebSocket is unavailable — acceptable for
  v1's target audience (modern browsers)

## Alternatives Considered

- **Socket.IO:** rejected — abstracts away connection lifecycle, room management, and
  reconnection, which are exactly the mechanics this project exists to learn deeply.
  Would be the pragmatic choice for a purely product-focused build, but not for this
  project's dual goal of learning + shipping.
- **uWebSockets.js:** rejected for now — a lower-level, higher-performance option, but
  premature optimization at this stage. Worth revisiting later as a focused
  performance-benchmarking side-experiment (e.g. comparing broadcast latency/throughput
  against the `ws`-based implementation under load).