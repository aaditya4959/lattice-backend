# ADR-0008: Production Hardening Decisions

**Status:** Accepted
**Date:** 2026-08-15
**Ticket:** SCRUM-59 (LAT-E6 / SCRUM-51)

## Context

`LAT-E6` closes the gap between "every functional v1 goal from `docs/DESIGN.md` §2 is
built" (true as of `LAT-E5`) and "actually safe to run for real users." Four of its
tickets made non-trivial technical decisions worth recording in one place rather than
leaving scattered across commit history and code comments: replacing the ad hoc schema
bootstrap with real migrations (SCRUM-53), refusing to boot on a missing production
secret instead of failing open (SCRUM-54), rate-limiting the auth endpoints (SCRUM-56),
and load-testing to replace two placeholder tuning constants with real numbers
(SCRUM-58). The epic's other tickets — a concurrent-boot race fix (SCRUM-52), a
collaborator-removal endpoint (SCRUM-55), and a health check (SCRUM-57) — are
straightforward bug fixes and CRUD/ops additions, not decisions with alternatives worth
weighing here.

## Decision

### 1. Migration tool: `node-pg-migrate` v7.9.1, not the latest v9

The previous schema setup (`schema.ts`, now deleted) was a hand-rolled, idempotent
`CREATE ... IF NOT EXISTS` bootstrap run on every boot — no schema history, no safe way
to express a destructive change (a column rename or drop has no `IF NOT EXISTS`
equivalent), and it had already accumulated one-off workarounds for `pg-mem` quirks and
a real concurrent-boot FK race (SCRUM-52). `node-pg-migrate` replaces it with real,
timestamp-ordered migration files (`migrations/*.ts`) and a tracking table
(`pgmigrations`).

The latest major (v9, and v8 before it) is ESM-only — `"type": "module"` in its own
`package.json`, and `import.meta.dirname` inside a file `runner()` transitively
requires even though nothing in this codebase calls the CLI-scaffolding feature that
uses it. `import.meta` is invalid syntax outside a true ES module context, which is a
hard parse-time failure under Jest's CJS transform — confirmed not fixable via
`transformIgnorePatterns` alone, since that only rewrites which files get transformed,
not the syntax itself. v7.x is the last release with `"type": "commonjs"`, at two
costs, both worked around:

- **No `advisoryLockMode: 'wait'`** (v9-only; v7 only exposes a binary `noLock:
  boolean`, and defaults to failing fast with `"Another migration is already
  running"` when two instances race for the migration lock). Replaced with a
  hand-rolled retry wrapper in `PersistenceModule.runMigrations` that catches that
  exact message and retries with a short delay — verified against real Postgres:
  two genuinely concurrent instances both succeed across repeated runs; without the
  wrapper, one crashes on boot every time.
- **No bundled TS/ESM loader** (unlike v9's `jiti`) — v7 just `require()`s each
  migration file directly, which only works in an environment that already has a
  `.ts` require hook installed (`nest start`'s ts-node, or ts-jest under Jest).
  Booting the real production artifact (`node dist/main.js` — exactly what the
  Dockerfile's production stage runs, since it ships only `dist/`) crashed outright
  on a raw `.ts` migration file. Fixed with an explicit extra build step
  (`tsconfig.migrations.json` → `dist/migrations`, declarations/sourcemaps off since
  `node-pg-migrate`'s file filter only ignores dotfiles and would otherwise also try
  to `require()` the emitted `.d.ts`/`.map` files) and `PersistenceModule` picking
  the matching directory at runtime based on its own `__filename` extension.

`migrationPromise` (module-scope, holding the in-flight promise rather than a boolean
flag) additionally guards against a same-process race some e2e specs exercise
directly — building two `TestingModule`s concurrently via `Promise.all` — that a
boolean guard left a window for, since it only prevents re-entry after a check that two
near-simultaneous callers can both pass before either finishes.

### 2. Fail-fast on a missing production secret, not fail-open

`JWT_SECRET` (`auth.module.ts`), `DATABASE_URL` (`postgres.provider.ts`), and
`REDIS_URL` (`redis.provider.ts`) each fell back silently to a hardcoded dev-only
default when unset — convenient for local dev, but meant a real deployment that forgot
to set one would fail *open* with a known, guessable value instead of refusing to boot.
This was flagged explicitly as a follow-up in ADR-0006's Consequences rather than fixed
piecemeal there.

A shared helper, `requireEnv(name, devFallback)` (`src/config/require-env.ts`), now
backs all three: returns the env var if set; if unset, falls back to the dev default
only when `NODE_ENV` is `development`/`test`/unset, otherwise throws — crashing boot
before the app starts listening, with a message naming exactly which var is missing.
Unset counts as dev-like specifically because the actual production Docker image sets
`NODE_ENV=production` explicitly (`Dockerfile`), so nothing that already boots the app
for real is affected; only a bare `node dist/main.js` with no `NODE_ENV` at all — not
this project's actual deployment path — would newly need one set. `docker-compose.yaml`'s
dev `app` service already sets `NODE_ENV=development`, and Jest already sets
`NODE_ENV=test` on its own, so local dev and the e2e/unit suites hold their existing
behavior by construction, not a test-specific carve-out in application code.

### 3. Rate limiting: `@nestjs/throttler`, scoped to register/login only, 5 requests/60s

`POST /auth/register` and `POST /auth/login` had no abuse protection — unlimited rapid
requests from one client were silently processed. `ThrottlerModule` is registered
inside `AuthModule` (not globally in `AppModule`), and `ThrottlerGuard` is applied
per-route via `@UseGuards` directly on the `register`/`login` controller methods, not
the whole controller — `GET /auth/me` is a read of already-proven identity, not a
credential guess, and stays out of scope. `@nestjs/throttler`'s default key includes
the handler name, so register and login are tracked as separate buckets; a burst of
one doesn't consume the other's budget.

5 requests per 60 seconds per (IP, route) is a conservative, literature-typical
anti-brute-force threshold (OWASP's ASVS guidance on authentication throttling), not an
empirically load-tested figure the way §4's interval tuning is — brute-force resistance
depends on attacker cost, not server capacity, so there's no analogous "load test until
it breaks" methodology for choosing this number. It's deliberately generous enough that
no legitimate single-session usage pattern in the existing e2e suite comes close (the
largest existing test exercises at most 3 register/login pairs in one run).

### 4. Load testing: k6, WebSocket-driven, against real Postgres/Redis

`docs/DESIGN.md` §8 explicitly left "what's the right debounce interval for
snapshotting" open pending load testing, and `SNAPSHOT_INTERVAL_MS`
(`persistence/snapshot-scheduler.service.ts`) / `CURSOR_THROTTLE_MS`
(`sync/cursor-throttle.service.ts`) both shipped as documented, untuned placeholders.
`load-test/sync-load-test.js` (k6) provisions real users and shared docs through the
actual REST API in `setup()`, then has each virtual user hold a real WebSocket
connection through `/sync`, sending cursor updates and document edits at a steady
simulated typing/mouse-movement cadence.

Genuinely valid Yjs binary updates couldn't be generated inside the k6 script itself —
k6's JS runtime (goja) can't load the real `yjs` npm package, and `SyncGateway`'s
`handleUpdate` calls `Y.applyUpdate()` directly on whatever an `update` message
carries, so garbage bytes throw immediately. `load-test/update-fixtures.json` holds ten
pre-baked, genuinely valid single-word insertions generated ahead of time with the
app's real `yjs` dependency, cycled by virtual users during the run.

Run against a real local Postgres and Redis (not `pg-mem`/`ioredis-mock`) at roughly
double the concurrency the untuned placeholders were ever exercised against — see
`load-test/README.md` for the full methodology and exact numbers — both intervals held
up with zero errors at settings meaningfully tighter than the shipped placeholders,
giving real margin to tune down:

- **`SNAPSHOT_INTERVAL_MS`: 2000 → 1000.** 500ms held up cleanly with a consistent,
  non-growing ~100ms of real-world overhead (concurrent Postgres writes landing in the
  same tick across several docs). 1000ms roughly halves the previous crash-loss window
  while staying well inside the range actually validated, not at the edge of it.
- **`CURSOR_THROTTLE_MS`: 100 → 75.** 50ms held up cleanly too — server capacity was
  never the binding constraint at this concurrency, so the exact number is really a UX
  call (how smooth live cursor movement should feel) bounded by "does the server
  comfortably handle it," which the test answers affirmatively well below 75ms. 75ms
  is a genuine improvement with margin left above the tested 50ms floor, rather than
  shipping the most aggressive value tested.

Explicitly out of scope for this pass: finding the actual breaking point of either
mechanism, sustained multi-minute soak testing, and testing beyond `docs/DESIGN.md`'s
already-documented "hot doc" limitation (50+ concurrent editors on one doc) — this is a
*basic* load test, per the ticket's own wording, meant to replace two placeholders with
real numbers, not a full capacity-planning exercise.

## Consequences

- The rate-limit threshold (§3) and the cursor-throttle target (§4) both ultimately
  rest on judgment calls a load test alone can't fully settle — attacker-cost reasoning
  for the former, perceived-smoothness reasoning for the latter. Both are documented
  with their reasoning rather than presented as purely derived numbers, so a future
  revision has the actual grounds to reconsider them, not just the final values.
- `node-pg-migrate` v7.9.1's dependency tree carries one remaining high-severity
  transitive `npm audit` advisory (`glob`'s CLI `-c/--cmd` shell-injection flag) —
  accepted as out of scope, since `node-pg-migrate` only uses `glob` as a library to
  find migration files and never invokes its CLI; the only fix is the v9 upgrade
  already rejected in §1 for the ESM/Jest incompatibility.
- `requireEnv`'s dev-like allowlist trusts `NODE_ENV` being unset as a proxy for "not a
  real deployment." This holds for every way this project actually boots today
  (Dockerfile sets `NODE_ENV=production` explicitly; `docker-compose.yaml`'s dev
  service sets `development`; Jest sets `test`), but would silently stay permissive if
  a future deployment path boots the compiled app without setting `NODE_ENV` at all —
  worth revisiting if a new deployment mechanism is added.
- The auth rate limiter is in-memory per instance (`@nestjs/throttler`'s default
  storage), not shared across horizontally-scaled instances the way `RedisFanoutService`
  shares document/presence state. A client distributing requests across multiple
  instances behind a load balancer could exceed the effective global limit. Acceptable
  for this project's current single-instance-in-practice deployment; a Redis-backed
  throttler storage is the natural fix if genuine horizontal scaling is added.

## Alternatives Considered

- **v9 + a Jest ESM interop shim (e.g. `@swc/jest`, `experimental-vm-modules`) instead
  of pinning to v7** — rejected. Would still need to solve `dist/main.js` loading raw
  `.ts` migrations in production regardless of the Jest-side fix (§1's second problem
  is independent of the first), and would trade one dependency-version workaround for
  a project-wide Jest transform change with broader blast radius, for a dependency
  this project only touches at boot.
- **A Redis-backed or otherwise cross-instance rate-limit store from the start** —
  rejected as premature for §3. This project doesn't currently run more than one
  instance in practice; adding cross-instance coordination for a mechanism that only
  needs to work per-instance today would be complexity ahead of an actual need,
  consistent with this codebase's general "don't build for hypothetical scale" stance.
- **Deriving the cursor-throttle/snapshot-interval numbers purely from the load test's
  measured ceiling** (i.e., shipping the tightest values actually tested) — rejected
  for §4. Shipping at the edge of what was validated leaves no margin for conditions
  the test didn't cover (slower hardware, more docs, longer sustained load); the chosen
  defaults keep deliberate headroom below the tested floor instead.
