// Swaps `ioredis` for `ioredis-mock` at the module-loader level, for every e2e spec —
// this is ioredis-mock's own documented integration pattern, not a project-specific
// workaround. See src/sync/redis.provider.ts for why application code has no
// test-mode branch of its own.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-return
jest.mock('ioredis', () => require('ioredis-mock'));

// Same idea for Postgres: pg-mem's `createPg()` returns { Pool, Client } bound to one
// in-memory db, shared by every `import { Pool } from 'pg'` within this test file's
// module registry — so multiple app instances booted in the same file (e.g. to
// simulate a server restart) see the same data, while separate test files each get
// their own fresh db, since Jest re-runs setupFiles per file. See
// src/persistence/postgres.provider.ts for why application code has no test-mode
// branch of its own.
jest.mock('pg', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const { newDb } = require('pg-mem');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
  const db = newDb();
  // `pg-mem` implements very few native Postgres functions (its own words) — advisory
  // locks aren't among them (verified directly: `pg_advisory_lock`/
  // `pg_try_advisory_lock` don't exist at all). node-pg-migrate (SCRUM-53) uses these
  // to serialize concurrent migration runs against real Postgres; registered here as
  // no-ops rather than in application code, matching this file's own established
  // pattern — pg-mem is single-process/single-threaded within one test file, so
  // there's no real concurrency for a lock to protect against in the first place, and
  // this keeps PersistenceModule itself fully unaware it might be running against a
  // mock.
  for (const name of [
    'pg_advisory_lock',
    'pg_try_advisory_lock',
    'pg_advisory_unlock',
  ]) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    db.public.registerFunction({
      name,
      args: ['int'],
      returns: 'bool',
      implementation: () => true,
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  return db.adapters.createPg();
});
