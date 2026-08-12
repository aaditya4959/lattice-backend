import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import { fromBase64, toBase64 } from 'lib0/buffer';
import * as Y from 'yjs';
import request from 'supertest';
import { App } from 'supertest/types';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module';
import { textOf } from './helpers/yjs';
import { send, sleep, waitForMessage, waitForOpen } from './helpers/ws';

interface AuthResponseBody {
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

/**
 * SCRUM-42: the full flow the whole `LAT-E2` sprint (SCRUM-36 through SCRUM-41) built
 * toward, exercised end to end in one continuous scenario rather than per-module in
 * isolation — register → login → create doc → join via WS with a token → edit →
 * list docs → invite a collaborator → the collaborator can join too. Each of these
 * steps already has its own focused unit/e2e coverage elsewhere (auth.e2e-spec.ts,
 * docs.e2e-spec.ts, sync.e2e-spec.ts); this test's job is proving they compose
 * correctly as a single real user journey, not re-proving any one step in isolation.
 *
 * A single sequential `it()`, not several — the steps are causally dependent (you
 * can't join a doc that doesn't exist yet, can't invite before it exists, etc.), so
 * splitting into independent `it()` blocks would either duplicate setup or produce
 * tests that can only be understood by reading a different test's state first.
 */
describe('Full auth + doc lifecycle (e2e)', () => {
  let app: INestApplication<App>;
  let wsUrl: string;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.listen(0);
    wsUrl = `${(await app.getUrl()).replace(/^http/, 'ws')}/sync`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('registers, logs in, creates a doc, joins and edits it via WS, lists it, invites a collaborator, and the collaborator can join', async () => {
    const password = 'correct horse battery';
    const ownerEmail = `${Date.now()}-owner@example.test`;
    const collaboratorEmail = `${Date.now()}-collaborator@example.test`;

    // 1. Register the owner.
    const registerResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: ownerEmail, password })
      .expect(201);
    const { id: ownerId } = registerResponse.body as AuthResponseBody;

    // 2. Log in as the owner.
    const loginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: ownerEmail, password })
      .expect(200);
    const { accessToken: ownerToken } = loginResponse.body as LoginResponseBody;

    // 3. Create a doc as the owner.
    const createResponse = await request(app.getHttpServer())
      .post('/docs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Full lifecycle doc' })
      .expect(201);
    const { id: docId, ownerId: createdOwnerId } =
      createResponse.body as DocResponseBody;
    expect(createdOwnerId).toBe(ownerId);

    // 4. Join the doc over WS, authenticated with the same token — proves SCRUM-41's
    // access check accepts the actual owner, not just any valid token.
    const ownerSocket = new WebSocket(wsUrl);
    await waitForOpen(ownerSocket);
    const ownerJoined = waitForMessage(ownerSocket);
    send(ownerSocket, { type: 'join', docId, token: ownerToken });
    const ownerJoinedMessage = await ownerJoined;
    expect(ownerJoinedMessage.type).toBe('joined');

    // 5. Edit the doc.
    const ownerDoc = new Y.Doc();
    ownerDoc.getText('content').insert(0, 'written by the owner');
    send(ownerSocket, {
      type: 'update',
      docId,
      update: toBase64(Y.encodeStateAsUpdate(ownerDoc)),
    });
    await sleep(30); // let the server apply it — no one else is connected to await a broadcast from yet

    // 6. List docs as the owner — the created doc must appear.
    const listResponse = await request(app.getHttpServer())
      .get('/docs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const ownedDocs = listResponse.body as DocResponseBody[];
    expect(ownedDocs.map((doc) => doc.id)).toContain(docId);

    // 7. Register the collaborator.
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: collaboratorEmail, password })
      .expect(201);
    const collaboratorLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: collaboratorEmail, password })
      .expect(200);
    const { accessToken: collaboratorToken } =
      collaboratorLogin.body as LoginResponseBody;

    // 8. The owner invites the collaborator by email.
    await request(app.getHttpServer())
      .post(`/docs/${docId}/invite`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: collaboratorEmail })
      .expect(201);

    // The invite must also make the doc show up in the collaborator's own list —
    // proving the invite wrote a real doc_collaborators row, not just returned 201.
    const collaboratorListResponse = await request(app.getHttpServer())
      .get('/docs')
      .set('Authorization', `Bearer ${collaboratorToken}`)
      .expect(200);
    const collaboratorDocs = collaboratorListResponse.body as DocResponseBody[];
    expect(collaboratorDocs.map((doc) => doc.id)).toContain(docId);

    // 9. The collaborator can join over WS too, and sees the owner's edit — proving
    // SCRUM-41's access check accepts a collaborator, not just the owner.
    const collaboratorSocket = new WebSocket(wsUrl);
    await waitForOpen(collaboratorSocket);
    const collaboratorJoined = waitForMessage(collaboratorSocket);
    send(collaboratorSocket, {
      type: 'join',
      docId,
      token: collaboratorToken,
    });
    const collaboratorJoinedMessage = await collaboratorJoined;
    expect(collaboratorJoinedMessage.type).toBe('joined');
    if (collaboratorJoinedMessage.type !== 'joined') {
      throw new Error('unreachable');
    }

    const collaboratorDoc = new Y.Doc();
    Y.applyUpdate(
      collaboratorDoc,
      fromBase64(collaboratorJoinedMessage.initialState),
    );
    expect(textOf(collaboratorDoc)).toBe('written by the owner');

    ownerSocket.close();
    collaboratorSocket.close();
  });
});
