// Opts this file OUT of the global `jest.mock('pg', ...)` swap (test/jest.setup.ts) —
// this file needs a real Postgres. See the file-level comment below for why.
jest.unmock('pg');

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import { fromBase64, toBase64 } from 'lib0/buffer';
import { Client, Pool } from 'pg';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module';
import { PG_POOL } from '../src/persistence/postgres.provider';
import { SNAPSHOT_INTERVAL_MS } from '../src/persistence/snapshot-scheduler.service';
import { signTestToken } from './helpers/auth';
import { textOf } from './helpers/yjs';
import { send, sleep, waitForMessage, waitForOpen } from './helpers/ws';

const TEST_SNAPSHOT_INTERVAL_MS = 30;
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://lattice:lattice@localhost:5432/lattice';

async function isPostgresReachable(): Promise<boolean> {
  const client = new Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 1500,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function createInstance(): Promise<{
  app: INestApplication;
  url: string;
  module: TestingModule;
}> {
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
  return { app, url: `${baseUrl}/sync`, module };
}

/**
 * Inserts a user + doc row directly rather than going through AuthModule/DocsModule —
 * this file is testing snapshot restore, not those modules. Returns the owner's id so
 * the caller can mint a `join` token that SCRUM-41's access check (owner or
 * collaborator) will actually accept for this doc.
 */
async function seedDocRow(pool: Pool, docId: string): Promise<string> {
  const ownerId = randomUUID();
  await pool.query(
    'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
    [ownerId, `${ownerId}@example.test`, 'not-a-real-hash'],
  );
  await pool.query(
    'INSERT INTO docs (id, owner_id, title) VALUES ($1, $2, $3)',
    [docId, ownerId, 'Test doc'],
  );
  return ownerId;
}

/**
 * Covers "loading a doc restores identical state from its latest snapshot" against a
 * REAL Postgres — pg-mem cannot prove this. Verified directly: pg-mem's `bytea`
 * columns round-trip arbitrary binary data (Yjs's update encoding, which contains a
 * random per-doc client ID as raw binary header bytes) through a lossy internal
 * string representation, corrupting it regardless of whether it's inserted as a
 * Buffer parameter or a hex-string literal (0/10 round-trips matched byte-for-byte in
 * direct testing). Real Postgres's bytea has no such issue — this is purely a
 * limitation of that specific test double.
 *
 * Requires a reachable Postgres via DATABASE_URL (defaults to the docker-compose
 * connection string). Skips (doesn't fail) if none is reachable, so `npm run
 * test:e2e` stays green without infra — but this test only actually proves anything
 * once Postgres is running. See README/docker-compose.yaml to start one locally.
 */
describe('Persistence — restore from snapshot (e2e, real Postgres required)', () => {
  let reachable = false;

  beforeAll(async () => {
    reachable = await isPostgresReachable();
    if (!reachable) {
      console.warn(
        `[persistence-restore.e2e-spec] Skipping — no Postgres reachable at ${DATABASE_URL}. ` +
          'Set DATABASE_URL or run `docker-compose up postgres` to exercise this test.',
      );
    }
  });

  it('restores identical state on a fresh app instance from the latest snapshot, not from memory', async () => {
    if (!reachable) return;

    const docId = randomUUID();

    // First instance: write, let the snapshot throttle fire, then fully shut down —
    // its in-memory DocRegistryService is gone once app.close() resolves. Anything
    // the second instance sees has to come from Postgres, not a live process.
    const first = await createInstance();
    const ownerId = await seedDocRow(first.module.get(PG_POOL), docId);
    const token = await signTestToken(
      first.module.get(JwtService),
      undefined,
      ownerId,
    );

    const firstClient = new WebSocket(first.url);
    await waitForOpen(firstClient);
    const firstJoined = waitForMessage(firstClient);
    send(firstClient, { type: 'join', docId, token });
    await firstJoined;

    const seedDoc = new Y.Doc();
    seedDoc.getText('content').insert(0, 'restored from postgres');
    send(firstClient, {
      type: 'update',
      docId,
      update: toBase64(Y.encodeStateAsUpdate(seedDoc)),
    });

    await sleep(TEST_SNAPSHOT_INTERVAL_MS * 5);
    firstClient.close();
    await first.app.close();

    // Second, independent instance — separate DI container, separate
    // DocRegistryService, sharing only the real Postgres. Same JWT_SECRET (env var or
    // dev fallback) as the first, so the token minted there still verifies here.
    const second = await createInstance();
    const secondClient = new WebSocket(second.url);
    await waitForOpen(secondClient);
    const joined = waitForMessage(secondClient);
    send(secondClient, { type: 'join', docId, token });
    const joinedMessage = await joined;

    expect(joinedMessage.type).toBe('joined');
    if (joinedMessage.type !== 'joined') throw new Error('unreachable');

    const restored = new Y.Doc();
    Y.applyUpdate(restored, fromBase64(joinedMessage.initialState));
    expect(textOf(restored)).toBe('restored from postgres');

    secondClient.close();
    await second.app.close();
  });
});
