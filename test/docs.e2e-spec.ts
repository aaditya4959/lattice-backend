import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import { Pool } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PG_POOL } from '../src/persistence/postgres.provider';

interface RegisterResponseBody {
  id: string;
  email: string;
}

interface LoginResponseBody {
  accessToken: string;
}

interface DocResponseBody {
  id: string;
  ownerId: string;
  title: string;
}

async function registerAndLogin(
  app: INestApplication<App>,
  email: string,
): Promise<{ userId: string; email: string; token: string }> {
  const password = 'correct horse battery';
  const registerResponse = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  const { id: userId } = registerResponse.body as RegisterResponseBody;

  const loginResponse = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  const { accessToken: token } = loginResponse.body as LoginResponseBody;

  return { userId, email, token };
}

/**
 * Covers SCRUM-39 (create/list) and SCRUM-40 (get/delete/invite) acceptance criteria:
 * creating inserts a docs row with the correct owner, listing/getting/deleting never
 * leaks another user's private docs (a stranger gets a 404, identical to a nonexistent
 * doc ID), and only the owner can delete or invite — a non-owner collaborator gets 403.
 */
describe('Docs (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates a doc owned by the authenticated user', async () => {
    const { userId, token } = await registerAndLogin(
      app,
      `${Date.now()}-owner@example.test`,
    );

    const response = await request(app.getHttpServer())
      .post('/docs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'My first doc' })
      .expect(201);
    const body = response.body as DocResponseBody;

    expect(body.title).toBe('My first doc');
    expect(body.ownerId).toBe(userId);
    expect(typeof body.id).toBe('string');
  });

  it('rejects doc creation without a token', async () => {
    await request(app.getHttpServer())
      .post('/docs')
      .send({ title: 'Nope' })
      .expect(401);
  });

  it('rejects doc creation with an empty title via the global ValidationPipe', async () => {
    const { token } = await registerAndLogin(
      app,
      `${Date.now()}-empty@example.test`,
    );
    await request(app.getHttpServer())
      .post('/docs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '' })
      .expect(400);
  });

  it("lists only docs the user owns — never another user's private docs", async () => {
    const alice = await registerAndLogin(
      app,
      `${Date.now()}-alice@example.test`,
    );
    const bob = await registerAndLogin(app, `${Date.now()}-bob@example.test`);

    await request(app.getHttpServer())
      .post('/docs')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: "Alice's private doc" })
      .expect(201);

    const aliceList = await request(app.getHttpServer())
      .get('/docs')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    const aliceDocs = aliceList.body as DocResponseBody[];
    expect(aliceDocs.map((d) => d.title)).toContain("Alice's private doc");

    const bobList = await request(app.getHttpServer())
      .get('/docs')
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    const bobDocs = bobList.body as DocResponseBody[];
    expect(bobDocs.map((d) => d.title)).not.toContain("Alice's private doc");
  });

  it('rejects listing docs without a token', async () => {
    await request(app.getHttpServer()).get('/docs').expect(401);
  });

  it('lists a doc for a collaborator, not just the owner', async () => {
    const alice = await registerAndLogin(
      app,
      `${Date.now()}-alice2@example.test`,
    );
    const bob = await registerAndLogin(app, `${Date.now()}-bob2@example.test`);

    const createResponse = await request(app.getHttpServer())
      .post('/docs')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Shared doc' })
      .expect(201);
    const { id: docId } = createResponse.body as DocResponseBody;

    // Seeds a collaborator row directly rather than going through POST /:id/invite —
    // this test is only about the listing query's collaborator half
    // (docs.service.ts), not the invite endpoint itself (covered separately below).
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const pool = moduleFixture.get<Pool>(PG_POOL);
    await pool.query(
      'INSERT INTO doc_collaborators (doc_id, user_id, role) VALUES ($1, $2, $3)',
      [docId, bob.userId, 'editor'],
    );

    const bobList = await request(app.getHttpServer())
      .get('/docs')
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    const bobDocs = bobList.body as DocResponseBody[];
    expect(bobDocs.map((d) => d.title)).toContain('Shared doc');
  });

  describe('GET /docs/:id', () => {
    it('returns metadata and null latestSnapshotAt for a doc with no snapshot yet', async () => {
      const { token } = await registerAndLogin(
        app,
        `${Date.now()}-get-owner@example.test`,
      );
      const createResponse = await request(app.getHttpServer())
        .post('/docs')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Detail me' })
        .expect(201);
      const { id } = createResponse.body as DocResponseBody;

      const response = await request(app.getHttpServer())
        .get(`/docs/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const body = response.body as DocResponseBody & {
        latestSnapshotAt: string | null;
      };

      expect(body.id).toBe(id);
      expect(body.title).toBe('Detail me');
      expect(body.latestSnapshotAt).toBeNull();
    });

    it('returns a doc for a collaborator', async () => {
      const owner = await registerAndLogin(
        app,
        `${Date.now()}-get-owner2@example.test`,
      );
      const collaborator = await registerAndLogin(
        app,
        `${Date.now()}-get-collab@example.test`,
      );
      const createResponse = await request(app.getHttpServer())
        .post('/docs')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Shared detail' })
        .expect(201);
      const { id } = createResponse.body as DocResponseBody;

      await request(app.getHttpServer())
        .post(`/docs/${id}/invite`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ email: collaborator.email })
        .expect(201);

      await request(app.getHttpServer())
        .get(`/docs/${id}`)
        .set('Authorization', `Bearer ${collaborator.token}`)
        .expect(200);
    });

    it('returns 404 (not a data leak) for a doc the user has no access to', async () => {
      const owner = await registerAndLogin(
        app,
        `${Date.now()}-get-owner3@example.test`,
      );
      const stranger = await registerAndLogin(
        app,
        `${Date.now()}-get-stranger@example.test`,
      );
      const createResponse = await request(app.getHttpServer())
        .post('/docs')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Private detail' })
        .expect(201);
      const { id } = createResponse.body as DocResponseBody;

      await request(app.getHttpServer())
        .get(`/docs/${id}`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(404);
    });

    it('returns 404 for a doc ID that does not exist at all — same status as no access', async () => {
      const { token } = await registerAndLogin(
        app,
        `${Date.now()}-get-owner4@example.test`,
      );
      await request(app.getHttpServer())
        .get('/docs/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('rejects without a token', async () => {
      await request(app.getHttpServer())
        .get('/docs/00000000-0000-0000-0000-000000000000')
        .expect(401);
    });
  });

  describe('DELETE /docs/:id', () => {
    it('lets the owner delete their own doc', async () => {
      const { token } = await registerAndLogin(
        app,
        `${Date.now()}-del-owner@example.test`,
      );
      const createResponse = await request(app.getHttpServer())
        .post('/docs')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Delete me' })
        .expect(201);
      const { id } = createResponse.body as DocResponseBody;

      await request(app.getHttpServer())
        .delete(`/docs/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/docs/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('rejects deletion by a non-owner collaborator with 403', async () => {
      const owner = await registerAndLogin(
        app,
        `${Date.now()}-del-owner2@example.test`,
      );
      const collaborator = await registerAndLogin(
        app,
        `${Date.now()}-del-collab@example.test`,
      );
      const createResponse = await request(app.getHttpServer())
        .post('/docs')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: "Owner's doc" })
        .expect(201);
      const { id } = createResponse.body as DocResponseBody;

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const pool = moduleFixture.get<Pool>(PG_POOL);
      await pool.query(
        'INSERT INTO doc_collaborators (doc_id, user_id, role) VALUES ($1, $2, $3)',
        [id, collaborator.userId, 'editor'],
      );

      await request(app.getHttpServer())
        .delete(`/docs/${id}`)
        .set('Authorization', `Bearer ${collaborator.token}`)
        .expect(403);
    });

    it('returns 404 (not a data leak) deleting a doc the user has no access to', async () => {
      const owner = await registerAndLogin(
        app,
        `${Date.now()}-del-owner3@example.test`,
      );
      const stranger = await registerAndLogin(
        app,
        `${Date.now()}-del-stranger@example.test`,
      );
      const createResponse = await request(app.getHttpServer())
        .post('/docs')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Untouchable' })
        .expect(201);
      const { id } = createResponse.body as DocResponseBody;

      await request(app.getHttpServer())
        .delete(`/docs/${id}`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(404);
    });

    it('rejects without a token', async () => {
      await request(app.getHttpServer())
        .delete('/docs/00000000-0000-0000-0000-000000000000')
        .expect(401);
    });
  });

  describe('POST /docs/:id/invite', () => {
    it('lets the owner invite a registered user by email', async () => {
      const owner = await registerAndLogin(
        app,
        `${Date.now()}-inv-owner@example.test`,
      );
      const invitee = await registerAndLogin(
        app,
        `${Date.now()}-inv-invitee@example.test`,
      );
      const createResponse = await request(app.getHttpServer())
        .post('/docs')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Invite target' })
        .expect(201);
      const { id } = createResponse.body as DocResponseBody;

      const response = await request(app.getHttpServer())
        .post(`/docs/${id}/invite`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ email: invitee.email })
        .expect(201);
      const body = response.body as { userId: string; role: string };
      expect(body.userId).toBe(invitee.userId);
      expect(body.role).toBe('editor');

      const inviteeList = await request(app.getHttpServer())
        .get('/docs')
        .set('Authorization', `Bearer ${invitee.token}`)
        .expect(200);
      const inviteeDocs = inviteeList.body as DocResponseBody[];
      expect(inviteeDocs.map((d) => d.title)).toContain('Invite target');
    });

    it('fails cleanly inviting an email with no account', async () => {
      const owner = await registerAndLogin(
        app,
        `${Date.now()}-inv-owner2@example.test`,
      );
      const createResponse = await request(app.getHttpServer())
        .post('/docs')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'No such invitee' })
        .expect(201);
      const { id } = createResponse.body as DocResponseBody;

      await request(app.getHttpServer())
        .post(`/docs/${id}/invite`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ email: `${Date.now()}-nonexistent@example.test` })
        .expect(404);
    });

    it('rejects a duplicate invite of an already-collaborating user with 409', async () => {
      const owner = await registerAndLogin(
        app,
        `${Date.now()}-inv-owner3@example.test`,
      );
      const invitee = await registerAndLogin(
        app,
        `${Date.now()}-inv-invitee2@example.test`,
      );
      const createResponse = await request(app.getHttpServer())
        .post('/docs')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Double invite' })
        .expect(201);
      const { id } = createResponse.body as DocResponseBody;

      await request(app.getHttpServer())
        .post(`/docs/${id}/invite`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ email: invitee.email })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/docs/${id}/invite`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ email: invitee.email })
        .expect(409);
    });

    it('rejects an invite from a non-owner collaborator with 403', async () => {
      const owner = await registerAndLogin(
        app,
        `${Date.now()}-inv-owner4@example.test`,
      );
      const collaborator = await registerAndLogin(
        app,
        `${Date.now()}-inv-collab@example.test`,
      );
      const outsider = await registerAndLogin(
        app,
        `${Date.now()}-inv-outsider@example.test`,
      );
      const createResponse = await request(app.getHttpServer())
        .post('/docs')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Guarded doc' })
        .expect(201);
      const { id } = createResponse.body as DocResponseBody;

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const pool = moduleFixture.get<Pool>(PG_POOL);
      await pool.query(
        'INSERT INTO doc_collaborators (doc_id, user_id, role) VALUES ($1, $2, $3)',
        [id, collaborator.userId, 'editor'],
      );

      await request(app.getHttpServer())
        .post(`/docs/${id}/invite`)
        .set('Authorization', `Bearer ${collaborator.token}`)
        .send({ email: outsider.email })
        .expect(403);
    });

    it('rejects an invite with a malformed email via the global ValidationPipe', async () => {
      const owner = await registerAndLogin(
        app,
        `${Date.now()}-inv-owner5@example.test`,
      );
      const createResponse = await request(app.getHttpServer())
        .post('/docs')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Malformed invite target' })
        .expect(201);
      const { id } = createResponse.body as DocResponseBody;

      await request(app.getHttpServer())
        .post(`/docs/${id}/invite`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ email: 'not-an-email' })
        .expect(400);
    });

    it('returns 404 (not a data leak) inviting to a doc the user has no access to', async () => {
      const owner = await registerAndLogin(
        app,
        `${Date.now()}-inv-owner6@example.test`,
      );
      const stranger = await registerAndLogin(
        app,
        `${Date.now()}-inv-stranger@example.test`,
      );
      const createResponse = await request(app.getHttpServer())
        .post('/docs')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Locked doc' })
        .expect(201);
      const { id } = createResponse.body as DocResponseBody;

      await request(app.getHttpServer())
        .post(`/docs/${id}/invite`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .send({ email: owner.email })
        .expect(404);
    });

    it('rejects without a token', async () => {
      await request(app.getHttpServer())
        .post('/docs/00000000-0000-0000-0000-000000000000/invite')
        .send({ email: 'someone@example.test' })
        .expect(401);
    });
  });
});
