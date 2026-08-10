import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';

/**
 * Mints a valid JWT directly via the app's own JwtService, without registering a real
 * user — `join`'s token validation (SCRUM-38) only checks authenticity/expiry, not
 * whether `sub` corresponds to a real `users` row (that's SCRUM-41's doc-authorization
 * job, a separate concern). Tests that aren't specifically about auth just need a
 * token that passes verification, not a full register/login round-trip.
 */
export function signTestToken(
  jwt: JwtService,
  email = `${randomUUID()}@example.test`,
): Promise<string> {
  return jwt.signAsync({ sub: randomUUID(), email });
}
