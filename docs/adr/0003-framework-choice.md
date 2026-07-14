# ADR-0003: Use NestJS Over Fastify/Express for the Application Framework

**Status:** Accepted
**Date:** 2026-07-14
**Ticket:** LAT-6

## Context

Lattice needs a Node.js backend framework to house REST endpoints (auth, doc
management), the WebSocket sync gateway, and the eventual persistence/CRDT-handling
logic. The core hard problems in this project are CRDT correctness, connection
lifecycle management, and horizontal scaling via Redis fan-out (see ADR-0001,
ADR-0002) — not the choice of web framework itself. Given a solo effort with limited
daily hours, framework choice should minimize incidental complexity so effort stays
focused on the actual learning objectives.

Prior experience is directly relevant here: NestJS was already used on the Tabble
project (alongside Redis pub/sub and Socket.IO), so there is no ramp-up cost. Fastify
and raw Express were also considered as lighter-weight, higher-raw-throughput
alternatives.

## Decision

Use **NestJS** as the application framework for the entire backend, including REST
modules (`AuthModule`, `DocsModule`) and the custom WebSocket sync gateway (via
`WsAdapter`, wrapping raw `ws` per ADR-0002).

## Consequences

**Gains:**
- Zero framework ramp-up cost — prior hands-on experience means daily hours go toward
  the CRDT/sync engine, not relearning a framework
- Module/dependency-injection structure maps cleanly onto the project's architecture:
  `AuthModule`, `DocsModule`, `SyncModule`, `PersistenceModule` are independently
  testable units, which matters directly for the CI-driven, test-covered workflow this
  project follows (see `docs/DESIGN.md`, testing strategy)
- Built-in guards, interceptors, and pipes provide auth middleware and request
  validation with minimal boilerplate, reading as production-grade structure rather
  than a flat script
- NestJS explicitly supports custom WebSocket adapters, so choosing raw `ws` (ADR-0002)
  doesn't require fighting or bypassing the framework — it's a supported integration
  path, not a workaround

**Costs / risks:**
- Higher baseline abstraction and boilerplate (decorators, modules, providers) compared
  to a minimal Express or Fastify app — acceptable tradeoff given the DI/testability
  gains outweigh the extra ceremony for a project intended to look and behave like a
  real production codebase
- Not the highest-raw-throughput option available (Fastify benchmarks faster on raw
  request handling) — acceptable since the actual bottleneck in this system is
  WebSocket fan-out and CRDT merge logic, not REST endpoint throughput

## Alternatives Considered

- **Fastify:** rejected — faster raw HTTP throughput and a lighter footprint, but would
  require rebuilding the module/DI/testability structure NestJS provides for free, and
  offers no meaningful advantage for this project's actual bottlenecks (WebSocket
  fan-out, CRDT correctness), which are framework-agnostic concerns.
- **Raw Express:** rejected — minimal structure by default; would require manually
  layering in dependency injection, validation, and module boundaries that NestJS
  already provides, adding incidental complexity without upside for this project.