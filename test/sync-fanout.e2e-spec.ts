import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import { fromBase64, toBase64 } from 'lib0/buffer';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module';
import {
  createTestDoc,
  inviteCollaborator,
  registerTestUser,
} from './helpers/docs';
import { textOf } from './helpers/yjs';
import { send, waitForMessage, waitForOpen } from './helpers/ws';

interface Instance {
  app: INestApplication;
  url: string;
  module: TestingModule;
}

async function createInstance(): Promise<Instance> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(0);
  const baseUrl = (await app.getUrl()).replace(/^http/, 'ws');
  return { app, url: `${baseUrl}/sync`, module: moduleFixture };
}

/**
 * Waits for `socket`'s next `presence` messages until one includes every id in
 * `userIds`, up to `maxAttempts` messages. Needed because SCRUM-47's cross-instance
 * roll-call is inherently eventually-consistent: a newly-subscribing instance's FIRST
 * presence snapshot for a client may not yet include a user who joined earlier on a
 * DIFFERENT instance — it self-corrects via a follow-up broadcast once the roll-call
 * response arrives, typically within one Redis round trip, but not synchronously.
 */
async function waitForPresenceIncluding(
  socket: WebSocket,
  userIds: string[],
  maxAttempts = 5,
): Promise<string[]> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const message = await waitForMessage(socket);
    if (message.type !== 'presence') continue;
    const seen = message.users.map((user) => user.userId);
    if (userIds.every((id) => seen.includes(id))) return seen;
  }
  throw new Error(
    `Did not see a presence snapshot including [${userIds.join(', ')}] within ${maxAttempts} messages`,
  );
}

/**
 * Proves SCRUM-29's acceptance criteria: two genuinely separate NestJS applications
 * (separate DI containers, separate SyncGateway/DocRegistryService/RedisFanoutService
 * instances, separate HTTP listeners), simulating two server instances. They only
 * share Redis — nothing in-process is shared between them. `ioredis-mock` (swapped in
 * via test/jest.setup.ts) shares its in-memory pub/sub state across every client
 * built with the same host:port, exactly like two real `ioredis` clients would share
 * a real Redis server, so this exercises the actual cross-instance fan-out path.
 */
describe('Sync fan-out across server instances (e2e)', () => {
  let instanceA: Instance;
  let instanceB: Instance;
  let token: string;
  let userId: string;

  beforeEach(async () => {
    [instanceA, instanceB] = await Promise.all([
      createInstance(),
      createInstance(),
    ]);
    // Both instances share the same JWT_SECRET (env var or the same dev fallback), so
    // a token minted via either instance's JwtService verifies on both. They also
    // share the same mocked Postgres within this test file (test/jest.setup.ts's
    // jest.mock('pg', ...) factory runs once per file, not once per Pool instance), so
    // a doc created via instanceA's DocsService is visible to instanceB's too — same
    // as two real server instances pointed at the same real Postgres.
    ({ userId, token } = await registerTestUser(instanceA.app));
  });

  afterEach(async () => {
    await Promise.all([instanceA.app.close(), instanceB.app.close()]);
  });

  it('delivers an update applied on instance A to a client connected to instance B, via Redis', async () => {
    const docId = await createTestDoc(instanceA.app, userId);

    const clientOnA = new WebSocket(instanceA.url);
    const clientOnB = new WebSocket(instanceB.url);
    await Promise.all([waitForOpen(clientOnA), waitForOpen(clientOnB)]);

    const joinedOnA = waitForMessage(clientOnA);
    send(clientOnA, { type: 'join', docId, token });
    await joinedOnA;

    const joinedOnB = waitForMessage(clientOnB);
    send(clientOnB, { type: 'join', docId, token });
    await joinedOnB;
    await waitForMessage(clientOnB); // presence snapshot, sent right after joined

    const localDoc = new Y.Doc();
    localDoc.getText('content').insert(0, 'from instance A');

    const receivedOnB = waitForMessage(clientOnB);
    send(clientOnA, {
      type: 'update',
      docId,
      update: toBase64(Y.encodeStateAsUpdate(localDoc)),
    });

    const message = await receivedOnB;
    expect(message.type).toBe('update');
    if (message.type !== 'update') throw new Error('unreachable');

    const receivedDoc = new Y.Doc();
    Y.applyUpdate(receivedDoc, fromBase64(message.update));
    expect(textOf(receivedDoc)).toBe('from instance A');

    clientOnA.close();
    clientOnB.close();
  });

  it("updates instance B's own doc registry, not just the one already-open socket", async () => {
    const docId = await createTestDoc(instanceA.app, userId);

    // B needs a local client BEFORE A publishes — B only subscribes to a doc's Redis
    // channel once it has at least one local client on it (DESIGN.md §6), and Redis
    // pub/sub never replays missed messages to a late subscriber. That gap is exactly
    // what SCRUM-30's persistence closes later; it's not this ticket's job.
    const firstClientOnB = new WebSocket(instanceB.url);
    await waitForOpen(firstClientOnB);
    const firstJoined = waitForMessage(firstClientOnB);
    send(firstClientOnB, { type: 'join', docId, token });
    await firstJoined;
    await waitForMessage(firstClientOnB); // presence snapshot, sent right after joined

    const clientOnA = new WebSocket(instanceA.url);
    await waitForOpen(clientOnA);
    const joinedOnA = waitForMessage(clientOnA);
    send(clientOnA, { type: 'join', docId, token });
    await joinedOnA;

    const seedDoc = new Y.Doc();
    seedDoc.getText('content').insert(0, 'seeded via A');

    const receivedByFirstClientOnB = waitForMessage(firstClientOnB);
    send(clientOnA, {
      type: 'update',
      docId,
      update: toBase64(Y.encodeStateAsUpdate(seedDoc)),
    });
    await receivedByFirstClientOnB;

    // A second, later client joining the SAME instance B should see the up-to-date
    // state read straight from B's own DocRegistryService — proving the fan-out
    // actually updated instance B's authoritative doc, not just relayed a message to
    // the one socket that happened to already be open.
    const secondClientOnB = new WebSocket(instanceB.url);
    await waitForOpen(secondClientOnB);
    const secondJoined = waitForMessage(secondClientOnB);
    send(secondClientOnB, { type: 'join', docId, token });
    const joinedMessage = await secondJoined;

    expect(joinedMessage.type).toBe('joined');
    if (joinedMessage.type !== 'joined') throw new Error('unreachable');

    const bDoc = new Y.Doc();
    Y.applyUpdate(bDoc, fromBase64(joinedMessage.initialState));
    expect(textOf(bDoc)).toBe('seeded via A');

    firstClientOnB.close();
    clientOnA.close();
    secondClientOnB.close();
  });

  it('propagates presence across instances — a late-joining instance learns about an already-connected user via roll-call', async () => {
    const docId = await createTestDoc(instanceA.app, userId);
    const bob = await inviteCollaborator(instanceA.app, docId);

    // Alice joins on instance A first.
    const clientOnA = new WebSocket(instanceA.url);
    await waitForOpen(clientOnA);
    send(clientOnA, { type: 'join', docId, token });
    await waitForMessage(clientOnA); // joined
    await waitForMessage(clientOnA); // presence: just alice

    const aliceEventuallySeesBob = waitForPresenceIncluding(clientOnA, [
      userId,
      bob.userId,
    ]);

    // Bob joins on instance B — a DIFFERENT instance whose presence subscription for
    // this doc didn't exist until this exact join, so it never saw alice's earlier
    // join event. It has to roll-call to learn about her.
    const clientOnB = new WebSocket(instanceB.url);
    await waitForOpen(clientOnB);
    send(clientOnB, { type: 'join', docId, token: bob.token });
    await waitForMessage(clientOnB); // joined

    const bobSeenUsers = await waitForPresenceIncluding(clientOnB, [
      userId,
      bob.userId,
    ]);
    expect(bobSeenUsers.sort()).toEqual([userId, bob.userId].sort());

    // Symmetrically, alice (already connected, on the OTHER instance) is notified
    // once bob's join propagates back to instance A.
    const aliceSeenUsers = await aliceEventuallySeesBob;
    expect(aliceSeenUsers.sort()).toEqual([userId, bob.userId].sort());

    clientOnA.close();
    clientOnB.close();
  });

  it('delivers cursor updates across instances', async () => {
    const docId = await createTestDoc(instanceA.app, userId);
    const bob = await inviteCollaborator(instanceA.app, docId);

    const clientOnA = new WebSocket(instanceA.url);
    await waitForOpen(clientOnA);
    send(clientOnA, { type: 'join', docId, token });
    await waitForMessage(clientOnA); // joined
    await waitForMessage(clientOnA); // presence: just alice

    const clientOnB = new WebSocket(instanceB.url);
    await waitForOpen(clientOnB);
    send(clientOnB, { type: 'join', docId, token: bob.token });
    await waitForMessage(clientOnB); // joined

    // Let the roll-call settle on both sides first, so the only thing left in either
    // socket's queue afterward is the cursor message this test actually cares about.
    await waitForPresenceIncluding(clientOnA, [userId, bob.userId]);
    await waitForPresenceIncluding(clientOnB, [userId, bob.userId]);

    const cursorOnB = waitForMessage(clientOnB);
    send(clientOnA, { type: 'cursor', docId, position: 42 });

    const message = await cursorOnB;
    expect(message.type).toBe('cursor');
    if (message.type !== 'cursor') throw new Error('unreachable');
    expect(message.userId).toBe(userId);
    expect(message.position).toBe(42);

    clientOnA.close();
    clientOnB.close();
  });
});
