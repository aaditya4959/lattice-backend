import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import { fromBase64, toBase64 } from 'lib0/buffer';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module';
import { ClientMessage, ServerMessage } from '../src/sync/protocol';

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

// Y.Text.toString() isn't declared on YText in Yjs's shipped .d.ts (see
// src/sync/yjs.smoke.spec.ts) — same known gap, same suppression, used throughout.
function textOf(doc: Y.Doc): string {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return doc.getText('content').toString();
}

describe('SyncGateway (e2e)', () => {
  let app: INestApplication;
  let url: string;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    const baseUrl = (await app.getUrl()).replace(/^http/, 'ws');
    url = `${baseUrl}/sync`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers a sync-request with exactly the update the requester is missing', async () => {
    const docId = randomUUID();

    const writer = new WebSocket(url);
    await waitForOpen(writer);
    const writerJoined = waitForMessage(writer);
    send(writer, { type: 'join', docId });
    await writerJoined;

    // Seed the server's doc via a normal client update.
    const seedDoc = new Y.Doc();
    seedDoc.getText('content').insert(0, 'seeded content');
    send(writer, {
      type: 'update',
      docId,
      update: toBase64(Y.encodeStateAsUpdate(seedDoc)),
    });

    const reader = new WebSocket(url);
    await waitForOpen(reader);
    const readerJoined = waitForMessage(reader);
    send(reader, { type: 'join', docId });
    await readerJoined;

    // A fresh reader's state vector is empty, so sync-response should hand back the
    // server's entire current state — exactly the "state vector exchange" mechanism
    // ticket SCRUM-28 calls for, exercised independently of live broadcast.
    const emptyStateVector = Y.encodeStateVector(new Y.Doc());
    const syncResponse = waitForMessage(reader);
    send(reader, {
      type: 'sync-request',
      docId,
      stateVector: toBase64(emptyStateVector),
    });
    const response = await syncResponse;

    expect(response.type).toBe('sync-response');
    if (response.type !== 'sync-response') throw new Error('unreachable');

    const readerDoc = new Y.Doc();
    Y.applyUpdate(readerDoc, fromBase64(response.update));
    expect(textOf(readerDoc)).toBe('seeded content');

    writer.close();
    reader.close();
  });

  it("broadcasts one client's update to the other, and both converge", async () => {
    const docId = randomUUID();

    const clientA = new WebSocket(url);
    const clientB = new WebSocket(url);
    await Promise.all([waitForOpen(clientA), waitForOpen(clientB)]);

    const joinedA = waitForMessage(clientA);
    send(clientA, { type: 'join', docId });
    await joinedA;

    const joinedB = waitForMessage(clientB);
    send(clientB, { type: 'join', docId });
    await joinedB;

    // Two independent local Yjs docs, standing in for each client's own editor state.
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.getText('content').insert(0, 'hello ');
    docB.getText('content').insert(0, 'world');

    // A pushes its edit; B should receive it via broadcast (not A, since the gateway
    // must never echo an update back to its origin).
    const receivedByB = waitForMessage(clientB);
    send(clientA, {
      type: 'update',
      docId,
      update: toBase64(Y.encodeStateAsUpdate(docA)),
    });
    const messageAtB = await receivedByB;
    expect(messageAtB.type).toBe('update');
    if (messageAtB.type !== 'update') throw new Error('unreachable');
    expect(messageAtB.fromClientId).not.toBe('');
    Y.applyUpdate(docB, fromBase64(messageAtB.update));

    // B pushes its (now-merged) edit back; A should receive it symmetrically.
    const receivedByA = waitForMessage(clientA);
    send(clientB, {
      type: 'update',
      docId,
      update: toBase64(Y.encodeStateAsUpdate(docB)),
    });
    const messageAtA = await receivedByA;
    expect(messageAtA.type).toBe('update');
    if (messageAtA.type !== 'update') throw new Error('unreachable');
    Y.applyUpdate(docA, fromBase64(messageAtA.update));

    expect(textOf(docA)).toBe(textOf(docB));

    clientA.close();
    clientB.close();
  });
});
