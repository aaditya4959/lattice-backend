import {
  Inject,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Provider,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL, postgresProviders } from './postgres.provider';
import {
  DOC_COLLABORATORS_SCHEMA_SQL,
  DOC_SNAPSHOTS_DOC_ID_FK_SQL,
  DOC_SNAPSHOTS_SCHEMA_SQL,
  DOCS_SCHEMA_SQL,
  USERS_SCHEMA_SQL,
} from './schema';
import {
  SnapshotSchedulerService,
  SNAPSHOT_INTERVAL_MS,
} from './snapshot-scheduler.service';
import { SnapshotService } from './snapshot.service';

const snapshotIntervalProvider: Provider = {
  provide: SNAPSHOT_INTERVAL_MS,
  useValue: Number(process.env.SNAPSHOT_INTERVAL_MS ?? 2000),
};

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
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Idempotent (CREATE ... IF NOT EXISTS) — see schema.ts for why this isn't a real migration tool yet. */
  async onModuleInit(): Promise<void> {
    // Dependency order matters: docs.owner_id references users, doc_collaborators
    // references both docs and users, and the doc_snapshots FK references docs.
    await this.ensureSchemaObject('tables', 'users', USERS_SCHEMA_SQL);
    await this.ensureSchemaObject('tables', 'docs', DOCS_SCHEMA_SQL);
    await this.ensureSchemaObject(
      'tables',
      'doc_collaborators',
      DOC_COLLABORATORS_SCHEMA_SQL,
    );
    await this.ensureSchemaObject(
      'tables',
      'doc_snapshots',
      DOC_SNAPSHOTS_SCHEMA_SQL,
    );
    await this.ensureSchemaObject(
      'table_constraints',
      'doc_snapshots_doc_id_fkey',
      DOC_SNAPSHOTS_DOC_ID_FK_SQL,
    );
  }

  /**
   * Checked explicitly rather than just relying on "CREATE ... IF NOT EXISTS" (or, for
   * the FK, a bare `ALTER TABLE ADD CONSTRAINT`) being a no-op when re-run: avoids a
   * redundant DDL round-trip once the object already exists (real Postgres), and works
   * around a pg-mem limitation where re-running this exact DDL against a db that
   * already has the object throws, even though nothing would actually change (harmless
   * in production, but every app instance booted in an e2e test shares one mocked db —
   * see test/jest.setup.ts).
   *
   * `catalog` is `'tables'` or `'table_constraints'` — both are standard
   * `information_schema` views keyed by name, checked identically. (pg-mem doesn't
   * actually populate `table_constraints`, so the FK check always reports "missing"
   * under the mock; harmless, since pg-mem also happens to tolerate a duplicate ADD
   * CONSTRAINT silently — verified directly. Real Postgres populates it correctly and
   * does reject duplicates, which is what the catch-and-recheck below guards against.)
   */
  private async ensureSchemaObject(
    catalog: 'tables' | 'table_constraints',
    name: string,
    ddl: string,
  ): Promise<void> {
    const exists = async (): Promise<boolean> => {
      const column = catalog === 'tables' ? 'table_name' : 'constraint_name';
      const result = await this.pool.query(
        `SELECT 1 FROM information_schema.${catalog} WHERE ${column} = $1`,
        [name],
      );
      return result.rows.length > 0;
    };

    if (await exists()) return;

    try {
      await this.pool.query(ddl);
    } catch (err) {
      // Two instances can both pass the check above before either has created the
      // object — a real race if multiple real server instances boot simultaneously
      // against a fresh Postgres, too. Only swallow if the object exists now, meaning
      // someone else won the race; otherwise this is a genuine failure.
      if (await exists()) return;
      throw err;
    }
  }

  /** Closes the pool's connections on app shutdown — without this, real `pg.Pool` sockets leak. */
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
