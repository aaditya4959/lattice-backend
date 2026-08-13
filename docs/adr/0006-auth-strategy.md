# ADR-0006: Auth Strategy

**Status:** Accepted
**Date:** 2026-08-13
**Ticket:** SCRUM-43 (LAT-E2)

## Context

`LAT-E2` built auth out end to end across several tickets — `POST /auth/register` /
`POST /auth/login` (SCRUM-37), a REST guard plus token validation on the WebSocket
`join` message (SCRUM-38), and authorizing `join` against real doc
ownership/collaboration (SCRUM-41) — with each decision made inline, in the ticket that
needed it, and never written down in one place. This ADR consolidates the three
decisions SCRUM-43 calls out specifically: JWT vs. sessions, the password hashing
algorithm, and how a token gets from a WebSocket client to the server when WS has no
clean header-based auth at connect time the way REST does.

## Decision

### 1. JWT (stateless bearer tokens), not server-side sessions

`AuthService.login` issues a signed JWT (`@nestjs/jwt`'s `JwtService`) rather than
creating a server-side session. A few reasons converge on this:

- The sync layer (ADR-0005) is already built to scale horizontally behind Redis
  pub/sub fan-out, with no sticky-session requirement — an instance doesn't need to
  "remember" a client between requests. Sessions would reintroduce exactly the kind of
  shared, stateful store (session data, wherever it lives — Redis, Postgres) that the
  rest of the architecture deliberately avoids needing. A JWT is self-verifying by any
  instance holding the shared secret; no lookup required.
- `JwtService` is used directly, not `@nestjs/passport`/`passport-jwt`. Same reasoning
  already established for `JwtAuthGuard` and, before that, `SyncGateway`'s hand-rolled
  message dispatch (ADR-0002): Passport's strategy abstraction exists to support many
  auth schemes behind one interface, and this app has exactly one (JWT bearer tokens).
  A few transparent lines calling `JwtService.verifyAsync` directly is easier to read
  and debug than configuring a strategy object to do the same thing.
- Token payload (`AuthTokenPayload`) is minimal: `{ sub: userId, email }`. No roles,
  scopes, or doc-access claims are embedded. Doc-level authorization (owner vs.
  collaborator vs. no access) is looked up fresh from Postgres on every doc-scoped
  request or `join` (`DocsService.findAccessible`, SCRUM-40/41) instead of being baked
  into the token. A JWT can't be revoked mid-lifetime short of a blocklist (not built —
  see Consequences), so keeping authorization decisions *out* of the token and
  re-checked live avoids a stale-authorization window: a collaborator removed from a
  doc loses access on their very next `join` or REST call, not just once their token
  happens to expire.
- Expiry is 24 hours (`JwtModule.register({ signOptions: { expiresIn: '24h' } })`), a
  dev-appropriate default. There's no refresh-token flow — expiry just means re-login.
  Deferred as a decision, not ruled out.
- The signing secret comes from `JWT_SECRET`, falling back to a hardcoded
  `'dev-only-insecure-secret-do-not-use-in-production'` string when unset — the same
  env-var-with-dev-fallback pattern already used for `DATABASE_URL`
  (`postgres.provider.ts`) and `REDIS_HOST`/`REDIS_PORT` (`redis.provider.ts`): zero
  local-dev config, at the cost of failing "open" with a known secret if a real
  deployment forgets to set it. The fallback string is deliberately alarming so it
  can't be mistaken for a real secret if it ever surfaces in logs.

### 2. bcrypt, not Argon2id, for password hashing

`AuthService.register` hashes with `bcrypt` at 10 salt rounds
(`BCRYPT_SALT_ROUNDS`), not Argon2id — OWASP's current recommended default for new
projects. This is a deliberate, named tradeoff, not an oversight: `bcrypt`'s native
Node binding is mature and installs predictably across platforms and Docker base
images; Argon2's Node bindings have historically been a rougher install experience
(native toolchain requirements that don't always survive a slim Docker image cleanly).
For a project at this scale — a portfolio/learning artifact, not a system handling real
user credentials at risk — that installation friction isn't worth trading for Argon2's
stronger memory-hardness guarantees. 10 rounds is bcrypt's common default; no
threat-modeling exercise was done to tune it specifically.

### 3. Threading auth through the WebSocket gateway: a token field in the `join` message

REST routes use the conventional `Authorization: Bearer <token>` header
(`JwtAuthGuard`, reading `request.headers.authorization`) — Express/Nest support this
natively. WebSocket connections don't have an equivalent clean option at connect time,
and the real tradeoff is narrower than "WS can't do headers":

- A browser's native `WebSocket` constructor provides no way to set custom headers on
  the connect/upgrade request (unlike `fetch`). This app's actual client
  (`client/index.html`) is browser-based, so this rules out a header-based scheme for
  the real client, even though it isn't a limitation for e.g. Node's `ws` package used
  in this project's own e2e tests.
- Browsers *do* automatically attach cookies to a same-origin WS handshake, so a
  session-cookie approach was technically viable at the transport level. It was
  rejected anyway, because a cookie is either an opaque session id (reintroducing the
  server-side session state §1 already ruled out) or a JWT stored in a cookie instead
  of sent explicitly — and mixing an implicit, browser-automatic credential mechanism
  for WS with an explicit bearer-token mechanism for REST would mean two different
  auth mechanisms for what's conceptually one login. Keeping both REST and WS as "the
  client explicitly presents the same bearer token it got from `/auth/login`" is more
  symmetric and easier to reason about.
- A query-string token (`wss://.../sync?token=...`) was the other realistic option —
  rejected because tokens embedded in URLs get written to access logs, proxy logs, and
  browser history by default across most infrastructure, an unforced credential-leakage
  surface that costs nothing to avoid.
- DESIGN.md §4.2 had already sketched `join`'s shape as
  `{ type: 'join', docId, token }` — an application-level message sent immediately
  after the socket opens, before any other interaction. This shipped as designed
  (SCRUM-38, after being deferred at SCRUM-28 since no `AuthModule` existed yet):
  `SyncGateway.handleJoin` validates the token via `JwtService.verifyAsync` inside the
  message handler, not at the WS upgrade/handshake level. This leaves a brief window
  where a socket is connected but unauthenticated (between TCP/WS connect and a valid
  `join` arriving) — acceptable because zero server-side side effects happen until
  `handleJoin` succeeds: no connection-registry entry, no Redis subscribe, no doc load
  (see `SyncGateway`). A socket that never sends a valid `join` just sits idle and gets
  nothing.
- SCRUM-41 layered doc-level authorization on top of token validity: a *valid* token
  only grants `join` access to docs its user actually owns or collaborates on
  (`DocsService.findAccessible`, checked fresh against Postgres, not cached in the
  token — same reasoning as §1). No access — including a `docId` that doesn't exist at
  all — rejects with the same `{ type: 'error', code: 'forbidden' }`, so a client can't
  use `join` to enumerate real doc IDs.

## Consequences

**Gains:**

- No session infrastructure to build, scale, or persist — consistent with the sync
  layer's existing stateless-per-instance-plus-Redis-fanout architecture (ADR-0005),
  rather than introducing a second, different kind of shared state just for auth.
- Exactly one verification code path per transport — `JwtAuthGuard` for REST,
  `SyncGateway.handleJoin` for WS — both built directly on `JwtService`, with no
  duplicated token-parsing/verification logic between them.
- Doc-level authorization is always checked live against Postgres, never trusted from
  token contents, so access changes (an invite, a removal — once removal exists) take
  effect on the very next request, not on next token expiry.

**Costs / risks:**

- No revocation mechanism: a leaked or stolen token stays valid for its full 24-hour
  lifetime; the expiry window is the only mitigation. A real deployment would need
  either a revocation/blocklist (reintroducing some server-side state) or a
  short-lived-access-token-plus-refresh-token flow.
- No refresh-token flow: users fully re-authenticate every 24 hours. Acceptable for a
  demo/interview artifact; a real product would want this.
- `JWT_SECRET`'s dev fallback fails "open" with a known, hardcoded secret if a real
  deployment forgets to set the env var, rather than refusing to boot. This matches the
  same tradeoff already accepted for `DATABASE_URL`/`REDIS_HOST` elsewhere in the
  codebase, so fixing only this one in isolation would be inconsistent — a real fix
  (e.g. refuse to boot outside a recognized dev/test `NODE_ENV` without an explicit
  secret) is a follow-up covering all three fallback spots together, not scoped to this
  ADR.
- bcrypt's fixed cost factor doesn't scale with hardware the way memory-hard KDFs
  (Argon2, scrypt) are specifically designed to. Worth revisiting before any real
  deployment; not urgent at this project's current scale or threat model.

## Alternatives Considered

- **Server-side sessions (cookie-backed, e.g. Redis-stored):** rejected — reintroduces
  exactly the kind of shared mutable state the sync layer's Redis-fanout architecture
  was built to avoid needing for its own concerns, for no benefit specific to auth.
- **Session cookie for WS auth specifically, JWT for REST:** rejected — technically
  possible (cookies ride the WS handshake automatically), but splits auth into two
  different mechanisms for one conceptual login, and still needs server-side session
  storage for the cookie half.
- **Custom `Authorization` header on the WS handshake:** rejected — not supported by
  the browser-native `WebSocket` API used by this project's actual client.
- **Token as a `?token=` query parameter:** rejected — tokens in URLs are routinely
  captured by access logs, proxies, and browser history, an avoidable leakage surface.
- **`@nestjs/passport` / `passport-jwt`:** rejected — this app has exactly one auth
  scheme; Passport's multi-strategy abstraction adds indirection without buying
  anything here, consistent with ADR-0002's stance on `SyncGateway`.
- **Argon2id for password hashing:** rejected for this project specifically —
  OWASP's current general recommendation, but its Node bindings' native-toolchain
  install friction wasn't judged worth trading for bcrypt's simplicity at this
  project's scale and risk profile. Revisit if this ever handles real user data.
