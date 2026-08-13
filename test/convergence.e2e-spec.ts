import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import { fromBase64, toBase64 } from 'lib0/buffer';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module';
import { createTestDoc, registerTestUser } from './helpers/docs';
import { textOf } from './helpers/yjs';
import { send, sleep, waitForMessage, waitForOpen } from './helpers/ws';

/**
 * Proves SCRUM-33's acceptance criteria: two clients editing concurrently — neither
 * having seen the other's edit — converge to identical state, including when the
 * updates are applied out of order.
 *
 * "Converges" isn't enough on its own to prove the out-of-order case, since the
 * gateway (and every test so far) always happens to apply/broadcast updates in the
 * same order they were sent. The real CRDT guarantee this ticket is about is
 * commutativity: applying the SAME two updates in the OPPOSITE order must produce the
 * SAME result. That's tested directly and deterministically below (§2), using the
 * exact update bytes that flowed through the real gateway — not a synthetic example.
 */
describe('Concurrent-edit convergence (e2e)', () => {
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

  it('converges two concurrent, mutually-unaware edits regardless of application order', async () => {
    const docId = await createTestDoc(app, userId);

    const socketA = new WebSocket(url);
    const socketB = new WebSocket(url);
    await Promise.all([waitForOpen(socketA), waitForOpen(socketB)]);

    const joinedA = waitForMessage(socketA);
    send(socketA, { type: 'join', docId, token });
    await joinedA;

    const joinedB = waitForMessage(socketB);
    send(socketB, { type: 'join', docId, token });
    await joinedB;

    // Both start from the same empty state and edit without any knowledge of each
    // other — genuinely concurrent, not "A's edit, then B's edit on top of it."
    const docA = new Y.Doc();
    docA.getText('content').insert(0, 'AAAA');
    const updateFromA = Y.encodeStateAsUpdate(docA);

    const docB = new Y.Doc();
    docB.getText('content').insert(0, 'BBBB');
    const updateFromB = Y.encodeStateAsUpdate(docB);

    // §1 — send through the real gateway, deliberately in a controlled, specific
    // order (B's update lands on the server first, A's second), then confirm a
    // fresh third client converges to content containing both edits.
    send(socketB, { type: 'update', docId, update: toBase64(updateFromB) });
    await sleep(30); // let the server apply B's update before A's arrives
    send(socketA, { type: 'update', docId, update: toBase64(updateFromA) });
    await sleep(30);

    const socketC = new WebSocket(url);
    await waitForOpen(socketC);
    const joinedC = waitForMessage(socketC);
    send(socketC, { type: 'join', docId, token });
    const joinedMessageC = await joinedC;
    expect(joinedMessageC.type).toBe('joined');
    if (joinedMessageC.type !== 'joined') throw new Error('unreachable');

    const serverConverged = new Y.Doc();
    Y.applyUpdate(serverConverged, fromBase64(joinedMessageC.initialState));
    const serverResult = textOf(serverConverged);
    expect(serverResult).toContain('AAAA');
    expect(serverResult).toContain('BBBB');

    // §2 — the actual out-of-order proof: apply the SAME two update byte-blobs that
    // went through the gateway above, to two independent fresh docs, in OPPOSITE
    // orders. Both must match each other and match what the server converged to —
    // deterministic, no timing dependency at all.
    const orderBThenA = new Y.Doc();
    Y.applyUpdate(orderBThenA, updateFromB);
    Y.applyUpdate(orderBThenA, updateFromA);

    const orderAThenB = new Y.Doc();
    Y.applyUpdate(orderAThenB, updateFromA);
    Y.applyUpdate(orderAThenB, updateFromB);

    expect(textOf(orderBThenA)).toBe(textOf(orderAThenB));
    expect(textOf(orderBThenA)).toBe(serverResult);

    socketA.close();
    socketB.close();
    socketC.close();
  });
});
