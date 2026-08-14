import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE TABLE docs (
      id            uuid PRIMARY KEY,
      owner_id      uuid NOT NULL REFERENCES users(id),
      title         text NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('DROP TABLE docs;');
}
