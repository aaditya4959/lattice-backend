import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import { fromBase64, toBase64 } from 'lib0/buffer';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module';
import { ClientMessage, ServerMessage } from '../src/sync/protocol';

interface Instance {
  app: INestApplication;
  url: string;
}

async function createInstance(): Promise<Instance> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(0);
  const baseUrl = (await app.getUrl()).replace(/^http/, 'ws');
  return { app, url: `${baseUrl}/sync` };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once('open', () => resolve()));
}

function waitForMessage(socket: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve) => {
    socket.once('message', (data: Buffer) => {
      resolve(JSON.parse(data.toString()) as ServerMessage);
    });
  });
}

function send(socket: WebSocket, message: ClientMessage): void {
  socket.send(JSON.stringify(message));
}

function textOf(doc: Y.Doc): string {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return doc.getText('content').toString();
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

  beforeEach(async () => {
    [instanceA, instanceB] = await Promise.all([
      createInstance(),
      createInstance(),
    ]);
  });

  afterEach(async () => {
    await Promise.all([instanceA.app.close(), instanceB.app.close()]);
  });

  it('delivers an update applied on instance A to a client connected to instance B, via Redis', async () => {
    const docId = randomUUID();

    const clientOnA = new WebSocket(instanceA.url);
    const clientOnB = new WebSocket(instanceB.url);
    await Promise.all([waitForOpen(clientOnA), waitForOpen(clientOnB)]);

    const joinedOnA = waitForMessage(clientOnA);
    send(clientOnA, { type: 'join', docId });
    await joinedOnA;

    const joinedOnB = waitForMessage(clientOnB);
    send(clientOnB, { type: 'join', docId });
    await joinedOnB;

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
    const docId = randomUUID();

    // B needs a local client BEFORE A publishes — B only subscribes to a doc's Redis
    // channel once it has at least one local client on it (DESIGN.md §6), and Redis
    // pub/sub never replays missed messages to a late subscriber. That gap is exactly
    // what SCRUM-30's persistence closes later; it's not this ticket's job.
    const firstClientOnB = new WebSocket(instanceB.url);
    await waitForOpen(firstClientOnB);
    const firstJoined = waitForMessage(firstClientOnB);
    send(firstClientOnB, { type: 'join', docId });
    await firstJoined;

    const clientOnA = new WebSocket(instanceA.url);
    await waitForOpen(clientOnA);
    const joinedOnA = waitForMessage(clientOnA);
    send(clientOnA, { type: 'join', docId });
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
    send(secondClientOnB, { type: 'join', docId });
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
});
