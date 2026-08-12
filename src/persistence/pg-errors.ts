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
