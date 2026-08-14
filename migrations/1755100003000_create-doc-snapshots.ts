import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `doc_id` cascades — deleting a doc must not be blocked by its own snapshot rows
 * (SCRUM-40). Append-only by design (SnapshotService never updates a row in place),
 * so the primary access pattern is "the latest snapshot for a doc," hence the index.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE TABLE doc_snapshots (
      id            uuid PRIMARY KEY,
      doc_id        uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
      state         bytea NOT NULL,
      state_vector  bytea NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX doc_snapshots_doc_id_created_at_idx
      ON doc_snapshots (doc_id, created_at DESC);
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('DROP TABLE doc_snapshots;');
}
