/**
 * Shared `pg` error-code checks. Extracted out of AuthService (SCRUM-37) once
 * DocsService needed the same duplicate-row check for invite (SCRUM-40) — not
 * auth-specific, so it lives alongside the rest of the raw-`pg` persistence code.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === '23505'
  );
}

/**
 * Postgres error code 42710 ("duplicate_object") — what a real Postgres server
 * throws for `ADD CONSTRAINT` on a constraint name that already exists. Needed for
 * PersistenceModule's concurrent-boot FK race (SCRUM-52): `pg-mem` doesn't reproduce
 * this at all (verified directly — it silently tolerates a duplicate `ADD
 * CONSTRAINT`), so this only ever fires against real Postgres, which is exactly
 * where the race it guards against can actually happen.
 */
export function isDuplicateObject(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === '42710'
  );
}
