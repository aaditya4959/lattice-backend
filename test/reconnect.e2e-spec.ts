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
 * Proves SCRUM-31's acceptance criteria: a client that goes offline, misses
 * concurrent edits from another client, then reconnects and catches up via
 * `sync-request`/`sync-response` (not by re-fetching the whole document).
 *
 * "Converges" alone isn't a strong enough proof here — SCRUM-28's sync-request test
 * already showed that with an empty state vector, which is indistinguishable from a
 * full resync. The point of this ticket is specifically the *diff*, so this test
 * measures the sync-response's size against a real full-document resync and asserts
 * it's meaningfully smaller, not just that the content ends up correct.
 */
describe('Reconnect / resync protocol (e2e)', () => {
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

  it('catches a reconnecting client up on concurrent edits via a small diff, not a full resync', async () => {
    const docId = await createTestDoc(app, userId);

    // Client A joins and builds up a substantial amount of shared history.
    const socketA = new WebSocket(url);
    await waitForOpen(socketA);
    const joinedA = waitForMessage(socketA);
    send(socketA, { type: 'join', docId, token });
    await joinedA;

    const docA = new Y.Doc();
    docA.getText('content').insert(0, 'x'.repeat(3000));
    send(socketA, {
      type: 'update',
      docId,
      update: toBase64(Y.encodeStateAsUpdate(docA)),
    });
    await sleep(50); // let the server apply it — A has no one to broadcast to yet, nothing to await

    // A's state vector right before it goes offline — this is what a real client
    // would have persisted locally (e.g. IndexedDB) and would resume from later.
    const stateVectorBeforeDisconnect = Y.encodeStateVector(docA);
    socketA.close();

    // While A is offline, B joins, catches up to A's bulk content, and makes one
    // small concurrent edit.
    const socketB = new WebSocket(url);
    await waitForOpen(socketB);
    const joinedB = waitForMessage(socketB);
    send(socketB, { type: 'join', docId, token });
    const joinedMessageB = await joinedB;
    if (joinedMessageB.type !== 'joined') throw new Error('unreachable');

    const docB = new Y.Doc();
    Y.applyUpdate(docB, fromBase64(joinedMessageB.initialState));
    docB
      .getText('content')
      .insert(docB.getText('content').length, ' [B was here]');
    send(socketB, {
      type: 'update',
      docId,
      update: toBase64(Y.encodeStateAsUpdate(docB)),
    });
    await sleep(50); // let the server apply it — B also has no one to broadcast to right now

    // A reconnects: a new socket (the old one is gone), rejoin, then resync from
    // exactly where it left off — not from scratch.
    const socketA2 = new WebSocket(url);
    await waitForOpen(socketA2);
    const rejoined = waitForMessage(socketA2);
    send(socketA2, { type: 'join', docId, token });
    await rejoined;

    const syncResponse = waitForMessage(socketA2);
    send(socketA2, {
      type: 'sync-request',
      docId,
      stateVector: toBase64(stateVectorBeforeDisconnect),
    });
    const response = await syncResponse;
    expect(response.type).toBe('sync-response');
    if (response.type !== 'sync-response') throw new Error('unreachable');

    const diffBytes = fromBase64(response.update);
    const fullResyncBytes = Y.encodeStateAsUpdate(docB); // docB now holds the fully-converged state
    expect(diffBytes.length).toBeLessThan(fullResyncBytes.length / 2);

    // Apply the diff to A's own pre-disconnect doc — untouched since it went offline
    // — and confirm it converges to the fully up-to-date content.
    Y.applyUpdate(docA, diffBytes);
    expect(textOf(docA)).toBe(textOf(docB));
    expect(textOf(docA)).toContain('[B was here]');

    socketA2.close();
    socketB.close();
  });
});
