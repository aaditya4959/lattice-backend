import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { UsersService } from '../auth/users.service';
import { isUniqueViolation } from '../persistence/pg-errors';
import { PG_POOL } from '../persistence/postgres.provider';

const COLLABORATOR_ROLE = 'editor';

export interface CollaboratorRecord {
  userId: string;
  email: string;
  role: string;
}

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
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly users: UsersService,
  ) {}

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

  /** Docs the user owns, unioned with docs they're a collaborator on via doc_collaborators. */
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

  /**
   * Returns the doc only if `userId` has some access to it (owner or collaborator),
   * else null — the null case is what lets callers answer "no access" with a plain 404
   * instead of leaking whether the doc exists (SCRUM-40 acceptance criteria).
   */
  async findAccessible(
    docId: string,
    userId: string,
  ): Promise<DocRecord | null> {
    const result = await this.pool.query<DocRow>(
      `SELECT DISTINCT d.id, d.owner_id, d.title, d.created_at, d.updated_at
       FROM docs d
       LEFT JOIN doc_collaborators dc ON dc.doc_id = d.id
       WHERE d.id = $1 AND (d.owner_id = $2 OR dc.user_id = $2)`,
      [docId, userId],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * doc_collaborators/doc_snapshots both cascade off docs.id (ON DELETE CASCADE, see
   * migrations/) — a single DELETE here is enough, no manual cleanup of child rows.
   */
  async delete(docId: string): Promise<void> {
    await this.pool.query('DELETE FROM docs WHERE id = $1', [docId]);
  }

  /**
   * Every collaborator is added as an 'editor' — DESIGN.md's role model reserves
   * view-only for later, and only 'owner'/'editor' exist right now (see
   * migrations/..._create-doc-collaborators.ts). Owner-vs-collaborator authorization is the caller's
   * job (DocsController) — this method only resolves the invite and writes the row.
   */
  async inviteCollaborator(
    docId: string,
    email: string,
  ): Promise<CollaboratorRecord> {
    const user = await this.users.findByEmail(email);
    if (!user) {
      throw new NotFoundException('No account exists with that email');
    }

    try {
      await this.pool.query(
        'INSERT INTO doc_collaborators (doc_id, user_id, role) VALUES ($1, $2, $3)',
        [docId, user.id, COLLABORATOR_ROLE],
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'That user is already a collaborator on this doc',
        );
      }
      throw err;
    }

    return { userId: user.id, email: user.email, role: COLLABORATOR_ROLE };
  }
}
