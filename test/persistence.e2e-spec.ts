import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import { toBase64 } from 'lib0/buffer';
import { Pool } from 'pg';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module';
import { PG_POOL } from '../src/persistence/postgres.provider';
import { SNAPSHOT_INTERVAL_MS } from '../src/persistence/snapshot-scheduler.service';
import { SnapshotService } from '../src/persistence/snapshot.service';
import { signTestToken } from './helpers/auth';
import { send, sleep, waitForMessage, waitForOpen } from './helpers/ws';

// Short enough to keep the test fast, long enough to clearly separate "just sent" from
// "the throttle fired" — real production tuning is an open question per DESIGN.md §8,
// this is just what makes the test deterministic.
const TEST_SNAPSHOT_INTERVAL_MS = 30;

/**
 * Inserts a user + doc row directly (no AuthModule/DocsModule yet — those are later
 * LAT-E2 tickets) so `docId` satisfies doc_snapshots' FK, added in this same ticket
 * (SCRUM-36).
 */
async function seedDoc(pool: Pool, docId: string): Promise<void> {
  const ownerId = randomUUID();
  await pool.query(
    'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
    [ownerId, `${ownerId}@example.test`, 'not-a-real-hash'],
  );
  await pool.query(
    'INSERT INTO docs (id, owner_id, title) VALUES ($1, $2, $3)',
    [docId, ownerId, 'Test doc'],
  );
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
    await seedDoc(module.get(PG_POOL), docId);
    const token = await signTestToken(module.get(JwtService));

    const client = new WebSocket(url);
    await waitForOpen(client);
    const joined = waitForMessage(client);
    send(client, { type: 'join', docId, token });
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
