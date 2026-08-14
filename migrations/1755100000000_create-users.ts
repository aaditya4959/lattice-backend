import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE TABLE users (
      id            uuid PRIMARY KEY,
      email         text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('DROP TABLE users;');
}
