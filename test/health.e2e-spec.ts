import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PG_POOL } from '../src/persistence/postgres.provider';
import { REDIS_PUBLISHER } from '../src/sync/redis.provider';

interface HealthResponseBody {
  status: 'ok' | 'error';
  postgres: string;
  redis: string;
}

/**
 * Proves SCRUM-57's acceptance criteria. The failure cases can't be reproduced by
 * physically breaking the mocked pg-mem/ioredis-mock clients (their lifecycle
 * semantics on disconnect aren't a reliable stand-in for a real network failure), so
 * they're exercised by spying a rejection onto the exact same injected PG_POOL/
 * REDIS_PUBLISHER instances HealthController actually uses — the same DI wiring a
 * real Postgres/Redis outage would hit, just with a controlled, deterministic
 * failure instead of an unpredictable one.
 */
describe('Health check (e2e)', () => {
  let moduleFixture: TestingModule;
  let app: INestApplication<App>;

  beforeEach(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with both dependencies confirmed reachable', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);
    const body = response.body as HealthResponseBody;

    expect(body.status).toBe('ok');
    expect(body.postgres).toBe('ok');
    expect(body.redis).toBe('ok');
  });

  it('returns a non-200 naming Postgres when it is unreachable', async () => {
    // Same minimal-shape cast as the Redis case below — `pg`'s real `query` overloads
    // otherwise make `mockRejectedValueOnce` infer an unhelpful type.
    const pool = moduleFixture.get<{ query: () => Promise<unknown> }>(PG_POOL);
    jest
      .spyOn(pool, 'query')
      .mockRejectedValueOnce(new Error('connection refused'));

    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(503);
    const body = response.body as HealthResponseBody;

    expect(body.status).toBe('error');
    expect(body.postgres).toContain('unreachable');
    expect(body.postgres).toContain('connection refused');
    expect(body.redis).toBe('ok');
  });

  it('returns a non-200 naming Redis when it is unreachable', async () => {
    // Cast to a minimal shape for the spy — ioredis's real `ping` overloads (some
    // callback-based) make `jest.spyOn(redis, 'ping')` infer an unhelpful type for
    // `mockRejectedValueOnce`; this still patches the same real object, just typed
    // simply enough for the mock call to type-check.
    const redis = moduleFixture.get<{ ping: () => Promise<string> }>(
      REDIS_PUBLISHER,
    );
    jest
      .spyOn(redis, 'ping')
      .mockRejectedValueOnce(new Error('connection refused'));

    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(503);
    const body = response.body as HealthResponseBody;

    expect(body.status).toBe('error');
    expect(body.redis).toContain('unreachable');
    expect(body.redis).toContain('connection refused');
    expect(body.postgres).toBe('ok');
  });

  it('requires no authentication', async () => {
    // No Authorization header set at all — distinct from the rest of the API, which
    // uniformly requires a bearer token (JwtAuthGuard).
    await request(app.getHttpServer()).get('/health').expect(200);
  });
});
