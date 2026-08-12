/**
 * Ad hoc, idempotent schema bootstrap, run once on app startup (see
 * PersistenceModule.onModuleInit) — not a migration tool. Proportionate for a handful
 * of tables; flagged since SCRUM-30 (see ADR-0005) as something to replace with a real
 * migration runner (e.g. node-pg-migrate) once the schema keeps growing.
 *
 * Creation order matters: `docs.owner_id` references `users`, `doc_collaborators`
 * references both `docs` and `users`, and the `doc_snapshots` FK (added in a separate
 * statement, since `doc_snapshots` already existed before `docs` did — see SCRUM-30)
 * references `docs`. PersistenceModule applies these in dependency order.
 *
 * Ticket: SCRUM-36 (LAT-E2)
 */

export const USERS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id            uuid PRIMARY KEY,
    email         text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
  );
`;

export const DOCS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS docs (
    id            uuid PRIMARY KEY,
    owner_id      uuid NOT NULL REFERENCES users(id),
    title         text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
  );
`;

/**
 * doc_id's FK to docs(id) is added separately below (DOC_COLLABORATORS_DOC_ID_FK_SQL),
 * not inlined here — same reason as doc_snapshots: it needs to carry ON DELETE CASCADE
 * (SCRUM-40) and a drop-and-recreate pattern that survives a schema.ts CASCADE change
 * only works from an ALTER TABLE, not a CREATE TABLE IF NOT EXISTS that no-ops once the
 * table already exists.
 */
export const DOC_COLLABORATORS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS doc_collaborators (
    doc_id  uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id),
    role    text NOT NULL,
    PRIMARY KEY (doc_id, user_id)
  );
`;

/**
 * No cascade on user_id — there's no delete-user feature yet, so that behavior doesn't
 * need deciding now.
 */
export const DOC_COLLABORATORS_DOC_ID_FK_SQL = `
  ALTER TABLE doc_collaborators
    ADD CONSTRAINT doc_collaborators_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE;
`;

/**
 * No FK from doc_id to docs.id here — the `docs` table didn't exist yet when this
 * shipped (SCRUM-30). See DOC_SNAPSHOTS_DOC_ID_FK_SQL below, added once it does.
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

/**
 * ON DELETE CASCADE: SCRUM-40's DELETE /docs/:id needs deleting a doc to not be blocked
 * by its own snapshot rows.
 */
export const DOC_SNAPSHOTS_DOC_ID_FK_SQL = `
  ALTER TABLE doc_snapshots
    ADD CONSTRAINT doc_snapshots_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE;
`;
