import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../persistence/postgres.provider';

export interface DocRecord {
  id: string;
  ownerId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

interface DocRow {
  id: string;
  owner_id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: DocRow): DocRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Raw `pg.Pool` access, no ORM — same approach as SnapshotService/UsersService (see
 * ADR-0005), deferred as a decision until the schema needs enough entities to justify
 * one.
 *
 * Ticket: SCRUM-39 (LAT-E2)
 */
@Injectable()
export class DocsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(ownerId: string, title: string): Promise<DocRecord> {
    const id = randomUUID();
    const result = await this.pool.query<DocRow>(
      `INSERT INTO docs (id, owner_id, title)
       VALUES ($1, $2, $3)
       RETURNING id, owner_id, title, created_at, updated_at`,
      [id, ownerId, title],
    );
    return toRecord(result.rows[0]);
  }

  /**
   * Docs the user owns, unioned with docs they're a collaborator on
   * (doc_collaborators — populated by SCRUM-40's invite endpoint, not built yet, so
   * this always returns just owned docs for now; the query is written for the full
   * access model regardless, verified directly against a seeded doc_collaborators row
   * in tests rather than waiting for the invite endpoint to exist).
   */
  async listAccessibleTo(userId: string): Promise<DocRecord[]> {
    const result = await this.pool.query<DocRow>(
      `SELECT DISTINCT d.id, d.owner_id, d.title, d.created_at, d.updated_at
       FROM docs d
       LEFT JOIN doc_collaborators dc ON dc.doc_id = d.id
       WHERE d.owner_id = $1 OR dc.user_id = $1
       ORDER BY d.created_at DESC`,
      [userId],
    );
    return result.rows.map(toRecord);
  }
}
