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
): Promise<{ userId: string; token: string }> {
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

  return { userId, token };
}

/**
 * Covers SCRUM-39's acceptance criteria: creating inserts a docs row with the correct
 * owner, and listing never leaks another user's private docs. Also proves the
 * collaborator half of the listing query works — by seeding a doc_collaborators row
 * directly, since the invite endpoint that would normally create one is SCRUM-40, not
 * built yet.
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

    // Seeds what SCRUM-40's invite endpoint will create — that endpoint doesn't exist
    // yet, but the listing query's collaborator half (docs.service.ts) is real code
    // that needs a real row to prove it works, not just a query that looks right.
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
});
