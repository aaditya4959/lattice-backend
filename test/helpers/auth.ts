import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';

/**
 * Mints a valid JWT directly via the app's own JwtService, without a full
 * register/login round-trip. `join`'s token validation (SCRUM-38) only checks
 * authenticity/expiry; SCRUM-41 added a separate access check against real
 * `docs`/`doc_collaborators` rows keyed by `sub`. For tests that seed a `docs` row
 * directly (persistence.e2e-spec.ts, persistence-restore.e2e-spec.ts), `sub` must be
 * passed explicitly to match that row's `owner_id` — tests that don't care about doc
 * access at all (e.g. bad-token rejection) can omit it and get a random one.
 */
export function signTestToken(
  jwt: JwtService,
  email = `${randomUUID()}@example.test`,
  sub: string = randomUUID(),
): Promise<string> {
  return jwt.signAsync({ sub, email });
}
