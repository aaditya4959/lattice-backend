import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import { fromBase64, toBase64 } from 'lib0/buffer';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module';
import { ServerMessage } from '../src/sync/protocol';
import {
  createTestDoc,
  inviteCollaborator,
  registerTestUser,
} from './helpers/docs';
import { textOf } from './helpers/yjs';
import {
  expectNoMessage,
  send,
  sleep,
  waitForMessage,
  waitForOpen,
} from './helpers/ws';

describe('SyncGateway (e2e)', () => {
  let app: INestApplication;
  let url: string;
  let token: string;
  let userId: string;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    const baseUrl = (await app.getUrl()).replace(/^http/, 'ws');
    url = `${baseUrl}/sync`;
    ({ userId, token } = await registerTestUser(app));
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers a sync-request with exactly the update the requester is missing', async () => {
    const docId = await createTestDoc(app, userId);

    const writer = new WebSocket(url);
    await waitForOpen(writer);
    const writerJoined = waitForMessage(writer);
    send(writer, { type: 'join', docId, token });
    await writerJoined;

    // Seed the server's doc via a normal client update.
    const seedDoc = new Y.Doc();
    seedDoc.getText('content').insert(0, 'seeded content');
    send(writer, {
      type: 'update',
      docId,
      update: toBase64(Y.encodeStateAsUpdate(seedDoc)),
    });
    await sleep(30); // let the server apply it before the reader asks for a diff

    const reader = new WebSocket(url);
    await waitForOpen(reader);
    const readerJoined = waitForMessage(reader);
    send(reader, { type: 'join', docId, token });
    await readerJoined;
    await waitForMessage(reader); // presence snapshot, sent right after joined

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
    const docId = await createTestDoc(app, userId);

    const clientA = new WebSocket(url);
    const clientB = new WebSocket(url);
    await Promise.all([waitForOpen(clientA), waitForOpen(clientB)]);

    const joinedA = waitForMessage(clientA);
    send(clientA, { type: 'join', docId, token });
    await joinedA;
    await waitForMessage(clientA); // presence snapshot, sent right after joined

    const joinedB = waitForMessage(clientB);
    send(clientB, { type: 'join', docId, token });
    await joinedB;
    await waitForMessage(clientB); // presence snapshot, sent right after joined

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

  it('rejects join with a missing or invalid token', async () => {
    const docId = randomUUID();

    const noToken = new WebSocket(url);
    await waitForOpen(noToken);
    const noTokenError = waitForMessage(noToken);
    // @ts-expect-error -- deliberately sending a malformed message to prove the
    // server rejects it, not just that the TS type requires a token.
    send(noToken, { type: 'join', docId });
    const noTokenResponse = await noTokenError;
    expect(noTokenResponse.type).toBe('error');
    noToken.close();

    const badToken = new WebSocket(url);
    await waitForOpen(badToken);
    const badTokenError = waitForMessage(badToken);
    send(badToken, { type: 'join', docId, token: 'not-a-real-jwt' });
    const badTokenResponse = await badTokenError;
    expect(badTokenResponse.type).toBe('error');
    badToken.close();
  });

  it('rejects join for a doc the authenticated user has no access to', async () => {
    // A second, unrelated user owns this doc — `token` (this describe's registered
    // user) is neither its owner nor a collaborator.
    const stranger = await registerTestUser(app);
    const docId = await createTestDoc(app, stranger.userId);

    const socket = new WebSocket(url);
    await waitForOpen(socket);
    const errorMessage = waitForMessage(socket);
    send(socket, { type: 'join', docId, token });
    const response = await errorMessage;

    expect(response.type).toBe('error');
    if (response.type !== 'error') throw new Error('unreachable');
    expect(response.code).toBe('forbidden');

    socket.close();
  });

  it('rejects join for a docId that does not exist at all — same error as no access', async () => {
    const socket = new WebSocket(url);
    await waitForOpen(socket);
    const errorMessage = waitForMessage(socket);
    send(socket, { type: 'join', docId: randomUUID(), token });
    const response = await errorMessage;

    expect(response.type).toBe('error');
    if (response.type !== 'error') throw new Error('unreachable');
    expect(response.code).toBe('forbidden');

    socket.close();
  });

  describe('presence', () => {
    it('sends the joining client a presence snapshot that includes themselves', async () => {
      const docId = await createTestDoc(app, userId);

      const socket = new WebSocket(url);
      await waitForOpen(socket);
      send(socket, { type: 'join', docId, token });
      await waitForMessage(socket); // joined

      const presence = await waitForMessage(socket);
      expect(presence.type).toBe('presence');
      if (presence.type !== 'presence') throw new Error('unreachable');
      expect(presence.users.map((u) => u.userId)).toEqual([userId]);

      socket.close();
    });

    it('notifies an already-connected client when a second, different user joins', async () => {
      const docId = await createTestDoc(app, userId);
      const bob = await inviteCollaborator(app, docId);

      const aliceSocket = new WebSocket(url);
      await waitForOpen(aliceSocket);
      send(aliceSocket, { type: 'join', docId, token });
      await waitForMessage(aliceSocket); // joined
      await waitForMessage(aliceSocket); // presence: just alice

      const aliceNotifiedOfBob = waitForMessage(aliceSocket);

      const bobSocket = new WebSocket(url);
      await waitForOpen(bobSocket);
      send(bobSocket, { type: 'join', docId, token: bob.token });
      await waitForMessage(bobSocket); // joined
      const bobPresence = await waitForMessage(bobSocket);
      expect(bobPresence.type).toBe('presence');
      if (bobPresence.type !== 'presence') throw new Error('unreachable');
      expect(bobPresence.users.map((u) => u.userId).sort()).toEqual(
        [userId, bob.userId].sort(),
      );

      const aliceUpdate = await aliceNotifiedOfBob;
      expect(aliceUpdate.type).toBe('presence');
      if (aliceUpdate.type !== 'presence') throw new Error('unreachable');
      expect(aliceUpdate.users.map((u) => u.userId).sort()).toEqual(
        [userId, bob.userId].sort(),
      );

      aliceSocket.close();
      bobSocket.close();
    });

    it("does not notify other clients when a user opens a SECOND tab on a doc they're already on", async () => {
      const docId = await createTestDoc(app, userId);
      const bob = await inviteCollaborator(app, docId);

      const aliceSocket = new WebSocket(url);
      await waitForOpen(aliceSocket);
      send(aliceSocket, { type: 'join', docId, token });
      await waitForMessage(aliceSocket); // joined
      await waitForMessage(aliceSocket); // presence: just alice

      const aliceNotifiedOfBob = waitForMessage(aliceSocket);
      const bobSocket1 = new WebSocket(url);
      await waitForOpen(bobSocket1);
      send(bobSocket1, { type: 'join', docId, token: bob.token });
      await waitForMessage(bobSocket1); // joined
      await waitForMessage(bobSocket1); // presence
      await aliceNotifiedOfBob; // alice notified of bob's first connection

      // Bob opens a second tab on the SAME doc — the roster doesn't change (bob was
      // already counted), so alice should get nothing further.
      const bobSocket2 = new WebSocket(url);
      await waitForOpen(bobSocket2);
      send(bobSocket2, { type: 'join', docId, token: bob.token });
      await waitForMessage(bobSocket2); // joined
      await waitForMessage(bobSocket2); // presence (bob's own snapshot, still real)

      await expectNoMessage(aliceSocket);

      aliceSocket.close();
      bobSocket1.close();
      bobSocket2.close();
    });

    it('notifies remaining clients when a user fully disconnects (their last connection)', async () => {
      const docId = await createTestDoc(app, userId);
      const bob = await inviteCollaborator(app, docId);

      const aliceSocket = new WebSocket(url);
      await waitForOpen(aliceSocket);
      send(aliceSocket, { type: 'join', docId, token });
      await waitForMessage(aliceSocket); // joined
      await waitForMessage(aliceSocket); // presence: just alice

      const aliceNotifiedOfBobJoin = waitForMessage(aliceSocket);
      const bobSocket = new WebSocket(url);
      await waitForOpen(bobSocket);
      send(bobSocket, { type: 'join', docId, token: bob.token });
      await waitForMessage(bobSocket); // joined
      await waitForMessage(bobSocket); // presence
      await aliceNotifiedOfBobJoin;

      const aliceNotifiedOfBobLeave = waitForMessage(aliceSocket);
      bobSocket.close();
      const leaveMessage = await aliceNotifiedOfBobLeave;

      expect(leaveMessage.type).toBe('presence');
      if (leaveMessage.type !== 'presence') throw new Error('unreachable');
      expect(leaveMessage.users.map((u) => u.userId)).toEqual([userId]);

      aliceSocket.close();
    });

    it("does not notify other clients when only ONE of a user's several tabs closes", async () => {
      const docId = await createTestDoc(app, userId);
      const bob = await inviteCollaborator(app, docId);

      const aliceSocket = new WebSocket(url);
      await waitForOpen(aliceSocket);
      send(aliceSocket, { type: 'join', docId, token });
      await waitForMessage(aliceSocket); // joined
      await waitForMessage(aliceSocket); // presence: just alice

      const aliceNotifiedOfBob = waitForMessage(aliceSocket);
      const bobSocket1 = new WebSocket(url);
      await waitForOpen(bobSocket1);
      send(bobSocket1, { type: 'join', docId, token: bob.token });
      await waitForMessage(bobSocket1);
      await waitForMessage(bobSocket1);
      await aliceNotifiedOfBob;

      const bobSocket2 = new WebSocket(url);
      await waitForOpen(bobSocket2);
      send(bobSocket2, { type: 'join', docId, token: bob.token });
      await waitForMessage(bobSocket2);
      await waitForMessage(bobSocket2);

      // Bob still has bobSocket2 open on this doc — closing bobSocket1 shouldn't
      // change the roster.
      bobSocket1.close();
      await expectNoMessage(aliceSocket);

      aliceSocket.close();
      bobSocket2.close();
    });
  });

  describe('cursor', () => {
    it('throttles rapid cursor updates instead of delivering them one-for-one', async () => {
      const docId = await createTestDoc(app, userId);
      const bob = await inviteCollaborator(app, docId);

      const aliceSocket = new WebSocket(url);
      await waitForOpen(aliceSocket);
      send(aliceSocket, { type: 'join', docId, token });
      await waitForMessage(aliceSocket);
      await waitForMessage(aliceSocket);

      const aliceNotifiedOfBob = waitForMessage(aliceSocket);
      const bobSocket = new WebSocket(url);
      await waitForOpen(bobSocket);
      send(bobSocket, { type: 'join', docId, token: bob.token });
      await waitForMessage(bobSocket);
      await waitForMessage(bobSocket);
      await aliceNotifiedOfBob;

      const received: number[] = [];
      const collector = (data: Buffer): void => {
        const parsed = JSON.parse(data.toString()) as ServerMessage;
        if (parsed.type === 'cursor') received.push(parsed.position);
      };
      aliceSocket.on('message', collector);

      // A burst well within the default 100ms throttle window (CURSOR_THROTTLE_MS) —
      // sent as fast as this loop can push frames onto the socket.
      for (let position = 1; position <= 20; position++) {
        send(bobSocket, { type: 'cursor', docId, position });
      }
      await sleep(150); // longer than the throttle window, so the trailing edge fires too

      aliceSocket.off('message', collector);

      expect(received.length).toBeGreaterThan(0);
      expect(received.length).toBeLessThan(20);
      expect(received[0]).toBe(1); // leading edge: the first update, delivered immediately
      expect(received[received.length - 1]).toBe(20); // trailing edge: the latest position

      aliceSocket.close();
      bobSocket.close();
    });
  });
});
