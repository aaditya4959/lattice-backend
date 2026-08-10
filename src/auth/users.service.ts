import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../persistence/postgres.provider';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
}

function toRecord(row: UserRow): UserRecord {
  return { id: row.id, email: row.email, passwordHash: row.password_hash };
}

/**
 * Raw `pg.Pool` access, no ORM — same approach as SnapshotService (see ADR-0005),
 * deferred as a decision until the schema needs enough entities to justify one.
 *
 * Ticket: SCRUM-37 (LAT-E2)
 */
@Injectable()
export class UsersService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findByEmail(email: string): Promise<UserRecord | null> {
    const result = await this.pool.query<UserRow>(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      [email],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * Throws the underlying `pg` error (code `23505`) on a duplicate email — callers
   * translate that to a clean HTTP response rather than this service pre-checking
   * existence, which would just be the same race with extra steps.
   */
  async create(email: string, passwordHash: string): Promise<UserRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
      [id, email, passwordHash],
    );
    return { id, email, passwordHash };
  }
}
