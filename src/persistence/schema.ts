/**
 * Ad hoc, idempotent schema bootstrap for `doc_snapshots`, run once on app startup
 * (see PersistenceModule.onModuleInit) — not a migration tool. This is proportionate
 * for a single table; once AuthModule/DocsModule need the rest of DESIGN.md §5's
 * schema (docs, users, doc_collaborators), replace this with a proper migration
 * runner (e.g. node-pg-migrate) rather than growing this file.
 *
 * No FK from doc_id to docs.id: the `docs` table doesn't exist yet (AuthModule/
 * DocsModule are still empty shells per CLAUDE.md). Tighten this once it does.
 *
 * Ticket: SCRUM-30 (LAT-E1B)
 */
export const DOC_SNAPSHOTS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS doc_snapshots (
    id            uuid PRIMARY KEY,
    doc_id        uuid NOT NULL,
    state         bytea NOT NULL,
    state_vector  bytea NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
  );

  -- Primary access pattern is "the latest snapshot for a doc" (SnapshotService.getLatest).
  CREATE INDEX IF NOT EXISTS doc_snapshots_doc_id_created_at_idx
    ON doc_snapshots (doc_id, created_at DESC);
`;
