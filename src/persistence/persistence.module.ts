import {
  Inject,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Provider,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL, postgresProviders } from './postgres.provider';
import { DOC_SNAPSHOTS_SCHEMA_SQL } from './schema';
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
  exports: [SnapshotService, SnapshotSchedulerService],
})
export class PersistenceModule implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Idempotent (CREATE ... IF NOT EXISTS) — see schema.ts for why this isn't a real migration tool yet. */
  async onModuleInit(): Promise<void> {
    // Checked explicitly rather than just relying on "CREATE ... IF NOT EXISTS" being
    // a no-op when re-run: avoids a redundant DDL round-trip once the table already
    // exists (real Postgres), and works around a pg-mem limitation where re-running
    // this exact DDL against a db that already has the table throws, even though
    // nothing would actually change (harmless in production, but every app instance
    // booted in an e2e test shares one mocked db — see test/jest.setup.ts).
    if (await this.tableExists()) return;

    try {
      await this.pool.query(DOC_SNAPSHOTS_SCHEMA_SQL);
    } catch (err) {
      // Two instances can both pass the check above before either has created the
      // table (a real race if multiple real server instances boot simultaneously
      // against a fresh Postgres, too — real Postgres's IF NOT EXISTS just silently
      // no-ops for the loser; pg-mem's test double throws instead). Only swallow if
      // the table exists now, meaning someone else won the race; otherwise this is a
      // genuine failure.
      if (await this.tableExists()) return;
      throw err;
    }
  }

  private async tableExists(): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'doc_snapshots'`,
    );
    return result.rows.length > 0;
  }

  /** Closes the pool's connections on app shutdown — without this, real `pg.Pool` sockets leak. */
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
