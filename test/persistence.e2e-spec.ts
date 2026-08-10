import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import { toBase64 } from 'lib0/buffer';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module';
import { SNAPSHOT_INTERVAL_MS } from '../src/persistence/snapshot-scheduler.service';
import { SnapshotService } from '../src/persistence/snapshot.service';
import { ClientMessage, ServerMessage } from '../src/sync/protocol';

// Short enough to keep the test fast, long enough to clearly separate "just sent" from
// "the throttle fired" — real production tuning is an open question per DESIGN.md §8,
// this is just what makes the test deterministic.
const TEST_SNAPSHOT_INTERVAL_MS = 30;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Covers "snapshot written on a debounce interval" against the mocked Postgres
 * (test/jest.setup.ts). Deliberately does NOT decode the stored bytes back into a
 * Y.Doc — pg-mem's `bytea` emulation is not binary-safe (confirmed: it round-trips
 * arbitrary binary data, including Yjs's update encoding, through a lossy internal
 * string representation that corrupts it, independent of how the value is inserted).
 * That makes it unusable for proving byte-exact restore, which is what
 * persistence-restore.e2e-spec.ts checks against a real Postgres instead. This file
 * only asserts that a snapshot row exists with the right shape, which pg-mem handles
 * correctly.
 */
describe('Persistence — snapshot writes (e2e, mocked Postgres)', () => {
  it('writes a snapshot on the throttle interval', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SNAPSHOT_INTERVAL_MS)
      .useValue(TEST_SNAPSHOT_INTERVAL_MS)
      .compile();

    const app: INestApplication = module.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    const baseUrl = (await app.getUrl()).replace(/^http/, 'ws');
    const url = `${baseUrl}/sync`;

    const docId = randomUUID();
    const client = new WebSocket(url);
    await waitForOpen(client);
    const joined = waitForMessage(client);
    send(client, { type: 'join', docId });
    await joined;

    const snapshots = module.get(SnapshotService);
    expect(await snapshots.getLatest(docId)).toBeNull();

    const localDoc = new Y.Doc();
    localDoc.getText('content').insert(0, 'persist me');
    send(client, {
      type: 'update',
      docId,
      update: toBase64(Y.encodeStateAsUpdate(localDoc)),
    });

    // Give the throttle timer time to fire — see SnapshotSchedulerService for why
    // this is throttling (guaranteed write after intervalMs), not trailing debounce.
    await sleep(TEST_SNAPSHOT_INTERVAL_MS * 3);

    const stored = await snapshots.getLatest(docId);
    expect(stored).not.toBeNull();
    expect(stored!.state.length).toBeGreaterThan(0);
    expect(stored!.stateVector.length).toBeGreaterThan(0);

    client.close();
    await app.close();
  });
});
