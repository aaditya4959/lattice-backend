import { Provider } from '@nestjs/common';
import { Pool } from 'pg';

export const PG_POOL = Symbol('PG_POOL');

function createPool(): Pool {
  return new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://lattice:lattice@localhost:5432/lattice',
  });
}

/**
 * Always constructs a real `pg.Pool` — application code has no test-mode branch, same
 * approach as src/sync/redis.provider.ts. Tests swap `pg` for `pg-mem`'s adapter at
 * Jest's module-loader level instead (test/jest.setup.ts).
 *
 * Ticket: SCRUM-30 (LAT-E1B)
 */
export const postgresProviders: Provider[] = [
  { provide: PG_POOL, useFactory: createPool },
];
