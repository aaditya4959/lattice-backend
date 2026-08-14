import * as path from 'node:path';
import {
  Inject,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Provider,
} from '@nestjs/common';
import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';
import { PG_POOL, postgresProviders } from './postgres.provider';
import {
  SnapshotSchedulerService,
  SNAPSHOT_INTERVAL_MS,
} from './snapshot-scheduler.service';
import { SnapshotService } from './snapshot.service';

// Tuned via SCRUM-58's k6 load test (load-test/sync-load-test.js), not the original
// placeholder — 500ms held up cleanly (zero errors, ~600ms actual write cadence, no
// growing backlog) at 20 concurrent users across 5 docs, double the concurrency the
// untuned 2000ms default was ever exercised against. 1000ms keeps real margin below
// that tested floor while roughly halving the previous placeholder's crash-loss
// window. See load-test/README.md for the full methodology and results.
const snapshotIntervalProvider: Provider = {
  provide: SNAPSHOT_INTERVAL_MS,
  useValue: Number(process.env.SNAPSHOT_INTERVAL_MS ?? 1000),
};

// node-pg-migrate v8+ is ESM-only ("type": "module", import.meta.dirname in a file
// transitively required by runner() even though we never call the affected
// CLI-scaffolding feature) — a hard syntax-level incompatibility with Jest's CJS
// transform, not fixable via transformIgnorePatterns (verified directly: that patch
// fixes a plain `import` but not `import.meta`). v7.x is the last "type": "commonjs"
// release, at the cost of losing v9's advisoryLockMode: 'wait' option (only a binary
// noLock: boolean exists in v7's types) — MIGRATION_LOCK_RETRY_* below hand-rolls the
// same "wait for the concurrent migration to finish" semantics on top of v7's
// fail-fast default. Verified against real Postgres: two genuinely concurrent
// instances both succeed across repeated runs with this wrapper; without it, one
// instance crashes on boot every time with exactly the message matched below.
//
// Expected benign log noise on the losing side of a lock race: each `runner()`
// call's own `finally` unconditionally tries to release the advisory lock, so a
// call that lost the race and never held it logs "Failed to release migration
// lock" as a `logger.warn` — caught and swallowed inside node-pg-migrate itself
// (dist/runner.js), never thrown, so it doesn't reach `isMigrationLockError` and
// doesn't affect the outcome (verified: still followed by a successful boot).
const MIGRATION_LOCK_ERROR = 'Another migration is already running';
const MIGRATION_LOCK_RETRY_DELAY_MS = 200;
const MIGRATION_LOCK_MAX_ATTEMPTS = 15;

function isMigrationLockError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(MIGRATION_LOCK_ERROR);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// v7.9.1 bundles no TS/ESM loader (unlike v9's `jiti`) — it just plain `require()`s
// each migration file, so it can only load `.ts` migrations in an environment that
// already has a `.ts` require hook installed (`nest start`'s ts-node, or ts-jest under
// Jest). Verified directly: booting the real compiled build (`node dist/main.js`,
// exactly what the production Docker image runs — see Dockerfile, which ships only
// `dist/`) crashed with a syntax error trying to `require()` a raw `.ts` migration
// file, since plain `node` has no such hook. `__filename` reveals which situation
// we're in: ts-node/ts-jest preserve the original `.ts` path, while a fully compiled
// run's `__filename` ends in `.js` — so route to the matching, always-loadable
// migrations directory: source `.ts` under `nest start`/tests, or the compiled `.js`
// copy (`tsconfig.migrations.json` → `dist/migrations`, run as an extra step of `npm
// run build`, sibling of this compiled file's own `dist/persistence`) in production.
const MIGRATIONS_DIR = __filename.endsWith('.ts')
  ? path.join(process.cwd(), 'migrations')
  : path.join(__dirname, '..', 'migrations');

/**
 * Module-scope, not instance-scope: guards against re-running migrations when
 * multiple `PersistenceModule` instances share one process — every e2e test file
 * creates a fresh NestJS `TestingModule` per `it()` block, all against the SAME
 * mocked `pg-mem` db (test/jest.setup.ts). A real app boot only ever calls
 * `onModuleInit` once per process anyway, so this is a no-op there.
 *
 * Holds the in-flight *promise*, not a boolean — some e2e specs
 * (`sync-fanout.e2e-spec.ts`) build two `TestingModule`s concurrently via
 * `Promise.all`, so two `onModuleInit` calls can both observe "not migrated yet"
 * before either finishes. A boolean set only after `runner()` resolves doesn't close
 * that window; every caller awaiting the same promise does, since the second caller
 * never starts its own `runner()` call in the first place. Verified directly: with a
 * boolean guard, concurrent instantiation intermittently hit "Table pgmigrations
 * already has a primary key" (two migration runs racing against the same mocked db).
 *
 * The underlying need for *some* guard is a `pg-mem` gap: node-pg-migrate's own
 * rerun-idempotency check for its `pgmigrations` tracking table queries
 * `information_schema.table_constraints` for an existing primary key — the exact
 * same view `pg-mem` doesn't populate correctly that was already documented as
 * broken for FK checks (SCRUM-36). Verified directly: a second `runner()` call
 * against an already-migrated `pg-mem` db fails with "already has a primary key,"
 * since the check that should have short-circuited it always reports "missing."
 * Real Postgres populates that view correctly and doesn't need this guard, but it's
 * harmless there too — the underlying `pgmigrations` table already reflects nothing
 * left to run, so a second real call would just log "No migrations to run!" anyway.
 */
let migrationPromise: Promise<void> | null = null;

@Module({
  providers: [
    SnapshotService,
    SnapshotSchedulerService,
    snapshotIntervalProvider,
    ...postgresProviders,
  ],
  // PG_POOL itself is exported, not just the snapshot-specific services above — other
  // modules (AuthModule's UsersService, later DocsModule) need direct raw query
  // access, not everything routed through persistence's own domain services.
  exports: [SnapshotService, SnapshotSchedulerService, PG_POOL],
})
export class PersistenceModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PersistenceModule.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Runs pending migrations from `migrations/` (SCRUM-53) — replaces the old ad hoc
   * `CREATE ... IF NOT EXISTS` bootstrap (schema.ts), which had no schema history, no
   * safe way to run a destructive change, and had already needed one-off workarounds
   * for `pg-mem` quirks and a real concurrent-boot race (SCRUM-52).
   */
  async onModuleInit(): Promise<void> {
    if (!migrationPromise) {
      migrationPromise = this.runMigrations();
    }
    await migrationPromise;
  }

  private async runMigrations(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Multiple real instances booting concurrently against the same real Postgres
      // must ALL succeed, not have whichever loses the advisory-lock race crash on
      // boot — the same concurrent-boot correctness SCRUM-52 fixed narrowly for one
      // FK constraint, now handled for the whole schema. v7 has no built-in "wait"
      // mode (see comment above), so this retries on the exact lock-contention error
      // instead.
      for (let attempt = 1; ; attempt++) {
        try {
          await runner({
            dbClient: client,
            migrationsTable: 'pgmigrations',
            dir: MIGRATIONS_DIR,
            direction: 'up',
            count: Infinity,
            log: (msg: string) => this.logger.log(msg),
          });
          return;
        } catch (err) {
          if (
            !isMigrationLockError(err) ||
            attempt >= MIGRATION_LOCK_MAX_ATTEMPTS
          ) {
            throw err;
          }
          await delay(MIGRATION_LOCK_RETRY_DELAY_MS);
        }
      }
    } finally {
      client.release();
    }
  }

  /** Closes the pool's connections on app shutdown — without this, real `pg.Pool` sockets leak. */
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
