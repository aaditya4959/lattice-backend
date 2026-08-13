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
  DOC_COLLABORATORS_DOC_ID_FK_SQL,
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
    await this.ensureForeignKey(
      'doc_collaborators',
      'doc_collaborators_doc_id_fkey',
      DOC_COLLABORATORS_DOC_ID_FK_SQL,
    );
    await this.ensureForeignKey(
      'doc_snapshots',
      'doc_snapshots_doc_id_fkey',
      DOC_SNAPSHOTS_DOC_ID_FK_SQL,
    );
  }

  /**
   * Checked explicitly rather than just relying on "CREATE TABLE IF NOT EXISTS" being a
   * no-op when re-run: avoids a redundant DDL round-trip once the table already exists
   * (real Postgres), and works around a pg-mem limitation where re-running this exact
   * DDL against a db that already has the table throws, even though nothing would
   * actually change (harmless in production, but every app instance booted in an e2e
   * test shares one mocked db — see test/jest.setup.ts).
   */
  private async ensureSchemaObject(
    catalog: 'tables',
    name: string,
    ddl: string,
  ): Promise<void> {
    const exists = async (): Promise<boolean> => {
      const result = await this.pool.query(
        `SELECT 1 FROM information_schema.${catalog} WHERE table_name = $1`,
        [name],
      );
      return result.rows.length > 0;
    };

    if (await exists()) return;

    try {
      await this.pool.query(ddl);
    } catch (err) {
      // Two instances can both pass the check above before either has created the
      // table — a real race if multiple real server instances boot simultaneously
      // against a fresh Postgres, too. Only swallow if the table exists now, meaning
      // someone else won the race; otherwise this is a genuine failure.
      if (await exists()) return;
      throw err;
    }
  }

  /**
   * Unlike tables, FK constraints hold no data of their own, so it's always safe to
   * drop and recreate one — that makes this self-healing when the constraint's
   * definition changes (e.g. adding ON DELETE CASCADE for SCRUM-40), unlike the
   * check-then-skip pattern above, which would leave an already-created constraint on
   * its old definition forever. `table` is needed for the DROP, since `ALTER TABLE ...
   * DROP CONSTRAINT` requires naming the table it's dropped from.
   */
  private async ensureForeignKey(
    table: string,
    constraintName: string,
    addConstraintDdl: string,
  ): Promise<void> {
    await this.pool.query(
      `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraintName}`,
    );
    await this.pool.query(addConstraintDdl);
  }

  /** Closes the pool's connections on app shutdown — without this, real `pg.Pool` sockets leak. */
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
