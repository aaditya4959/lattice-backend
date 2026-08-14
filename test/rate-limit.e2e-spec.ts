import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

const PASSWORD = 'correct horse battery';

/**
 * Proves SCRUM-56's acceptance criteria against the real default configuration
 * (`AUTH_RATE_LIMIT_MAX=5`/`AUTH_RATE_LIMIT_TTL_MS=60000`, auth.module.ts) rather than
 * a test-only override, so this only stays green if the shipped default actually
 * behaves as documented. register and login are tracked in separate buckets (
 * `@nestjs/throttler`'s default key includes the handler name), so five successful
 * calls to one doesn't consume the other's budget — each `it()` below only exercises
 * one endpoint. Each test gets a fresh `TestingModule`/`ThrottlerStorage`, so this
 * doesn't collide with the small number of register/login calls other e2e specs make
 * (all well under 5 per test — see auth.e2e-spec.ts, docs.e2e-spec.ts).
 */
describe('Auth rate limiting (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('allows up to the limit, then 429s the next register request', async () => {
    const base = `${Date.now()}-ratelimit-register`;
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: `${base}-${i}@example.test`, password: PASSWORD })
        .expect(201);
    }

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: `${base}-over@example.test`, password: PASSWORD })
      .expect(429);
  });

  it('allows up to the limit, then 429s the next login request', async () => {
    const email = `${Date.now()}-ratelimit-login@example.test`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: PASSWORD })
      .expect(201);

    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
    }

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(429);
  });

  it("doesn't rate-limit /auth/me — only register/login are in scope", async () => {
    const email = `${Date.now()}-ratelimit-me@example.test`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: PASSWORD })
      .expect(201);
    const loginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    const { accessToken } = loginResponse.body as { accessToken: string };

    for (let i = 0; i < 8; i++) {
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    }
  });
});
