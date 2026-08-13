import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from './postgres.provider';

export interface StoredSnapshot {
  state: Uint8Array;
  stateVector: Uint8Array;
  createdAt: Date;
}

interface SnapshotRow {
  state: Buffer;
  state_vector: Buffer;
  created_at: Date;
}

/**
 * Persistence for `doc_snapshots`, per DESIGN.md §5. Each save is a new row (not an
 * upsert) — the schema is deliberately append-only so it can support version
 * history/time-travel later (DESIGN.md §2 non-goal: no UI for it in v1, but the data
 * model already accommodates it). "Latest" is derived via ORDER BY created_at DESC.
 *
 * `stateVector` is captured and stored per DESIGN.md's schema, but nothing reads it
 * back yet — that's for SCRUM-31 (reconnect/resync protocol) to consume.
 *
 * Ticket: SCRUM-30 (LAT-E1B)
 */
@Injectable()
export class SnapshotService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async save(
    docId: string,
    state: Uint8Array,
    stateVector: Uint8Array,
  ): Promise<void> {
    await this.pool.query(
      'INSERT INTO doc_snapshots (id, doc_id, state, state_vector) VALUES ($1, $2, $3, $4)',
      [randomUUID(), docId, Buffer.from(state), Buffer.from(stateVector)],
    );
  }

  async getLatest(docId: string): Promise<StoredSnapshot | null> {
    const result = await this.pool.query<SnapshotRow>(
      'SELECT state, state_vector, created_at FROM doc_snapshots WHERE doc_id = $1 ORDER BY created_at DESC LIMIT 1',
      [docId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      state: new Uint8Array(row.state),
      stateVector: new Uint8Array(row.state_vector),
      createdAt: row.created_at,
    };
  }
}
