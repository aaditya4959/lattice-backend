/**
 * `JWT_SECRET`, `DATABASE_URL`, and `REDIS_URL` each used to fall back silently to a
 * hardcoded dev-only default when unset — convenient for local dev, but it means a
 * real deployment that forgets to set one fails "open" with a known, guessable value
 * instead of refusing to boot. Flagged explicitly as a follow-up in
 * docs/adr/0006-auth-strategy.md (Consequences) rather than fixed piecemeal there.
 *
 * `NODE_ENV` unset counts as dev-like, not just `'development'`/`'test'` — the actual
 * production Docker image sets `NODE_ENV=production` explicitly (Dockerfile), and
 * Jest sets `NODE_ENV=test` on its own, so nothing that already boots the app for
 * real (prod image, `docker-compose.yaml`'s dev service, the e2e/unit suites) is
 * affected; only a bare `node dist/main.js` with no `NODE_ENV` at all — not this
 * project's actual deployment path — would newly need one set.
 *
 * Ticket: SCRUM-54 (LAT-E6)
 */
// Dummy commit 
const DEV_LIKE_NODE_ENVS = new Set(['development', 'test', '']);

function isDevLikeEnvironment(): boolean {
  return DEV_LIKE_NODE_ENVS.has(process.env.NODE_ENV ?? '');
}

export function requireEnv(name: string, devFallback: string): string {
  const value = process.env[name];
  if (value) return value;
  if (isDevLikeEnvironment()) return devFallback;
  throw new Error(
    `${name} must be set outside local dev/test (NODE_ENV=${JSON.stringify(process.env.NODE_ENV)}) — refusing to boot with a fail-open default.`,
  );
}
