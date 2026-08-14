import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `doc_id` cascades — deleting a doc must not be blocked by its own collaborator rows
 * (SCRUM-40). No cascade on `user_id` — there's no delete-user feature yet, so that
 * behavior doesn't need deciding now.
 *
 * Unlike the old ad hoc bootstrap (schema.ts, pre-SCRUM-53), this FK is inline in the
 * same migration that creates the table, not split into a separate one. That split
 * only ever existed to work around the ad hoc bootstrap's incremental,
 * ticket-by-ticket history (doc_snapshots existed before docs did — see SCRUM-30/36).
 * A real migration set has no such constraint: this is a fresh sequence, so tables and
 * their FKs are created in the order they actually depend on each other.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE TABLE doc_collaborators (
      doc_id  uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id),
      role    text NOT NULL,
      PRIMARY KEY (doc_id, user_id)
    );
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('DROP TABLE doc_collaborators;');
}
