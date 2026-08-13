import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { AuthService } from '../../src/auth/auth.service';
import { DocsService } from '../../src/docs/docs.service';

const TEST_PASSWORD = 'correct horse battery';

/**
 * Registers a real user via the real AuthService — not just a signed token
 * (test/helpers/auth.ts's signTestToken) — because SCRUM-41's join authorization
 * checks the token's `sub` against real `docs`/`doc_collaborators` rows, not just
 * signature validity. Sync/reconnect/convergence e2e tests need a user that can
 * actually own a doc.
 */
export async function registerTestUser(
  app: INestApplication,
  email = `${randomUUID()}@example.test`,
): Promise<{ userId: string; token: string }> {
  const auth = app.get(AuthService);
  const { id: userId } = await auth.register(email, TEST_PASSWORD);
  const { accessToken: token } = await auth.login(email, TEST_PASSWORD);
  return { userId, token };
}

/** Creates a doc owned by `ownerId` directly via DocsService — no HTTP round trip needed. */
export async function createTestDoc(
  app: INestApplication,
  ownerId: string,
  title = 'Test doc',
): Promise<string> {
  const docs = app.get(DocsService);
  const doc = await docs.create(ownerId, title);
  return doc.id;
}

/** Convenience for the common case: one user, one doc they own. */
export async function registerUserWithDoc(
  app: INestApplication,
  email?: string,
): Promise<{ userId: string; token: string; docId: string }> {
  const { userId, token } = await registerTestUser(app, email);
  const docId = await createTestDoc(app, userId);
  return { userId, token, docId };
}

/**
 * Registers a second user and invites them as a collaborator on `docId` — presence/
 * cursor tests need two genuinely distinct authenticated users on the same doc, not
 * just two sockets for the same user. `app` only needs to share a Postgres/JWT_SECRET
 * with whichever instance the resulting token gets used against (see
 * sync-fanout.e2e-spec.ts, where it's called against instanceA but the returned token
 * is used to join on instanceB).
 */
export async function inviteCollaborator(
  app: INestApplication,
  docId: string,
): Promise<{ userId: string; token: string }> {
  const email = `${Date.now()}-${randomUUID()}@example.test`;
  const collaborator = await registerTestUser(app, email);
  await app.get(DocsService).inviteCollaborator(docId, email);
  return collaborator;
}
