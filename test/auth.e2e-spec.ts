import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

interface RegisterResponseBody {
  id: string;
  email: string;
}

interface LoginResponseBody {
  accessToken: string;
}

/**
 * Covers SCRUM-37's acceptance criteria directly. The broader cross-cutting flow
 * (register → login → create doc → join → edit → invite) is SCRUM-41's job; this file
 * is scoped to register/login in isolation.
 */
describe('Auth (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // AppModule includes SyncGateway (SCRUM-28); without an explicit adapter, Nest
    // tries to auto-load the default socket.io driver on init and crashes.
    app.useWebSocketAdapter(new WsAdapter(app));
    // main.ts's bootstrap() isn't invoked in tests — the global pipe has to be
    // registered here too, or DTO validation silently never runs.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('registers a new user and never returns the password or its hash', async () => {
    const email = `${Date.now()}@example.test`;

    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'correct horse battery' })
      .expect(201);
    const body = response.body as RegisterResponseBody & {
      password?: unknown;
      passwordHash?: unknown;
    };

    expect(body).toMatchObject({ email });
    expect(typeof body.id).toBe('string');
    expect(body.password).toBeUndefined();
    expect(body.passwordHash).toBeUndefined();
  });

  it('rejects a duplicate email registration with 409', async () => {
    const email = `${Date.now()}@example.test`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'correct horse battery' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'a different password entirely' })
      .expect(409);
  });

  it('rejects malformed registration input via the global ValidationPipe', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'not-an-email', password: 'short' })
      .expect(400);
  });

  it('logs in with correct credentials and returns a JWT the app itself can verify', async () => {
    const email = `${Date.now()}@example.test`;
    const password = 'correct horse battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const body = response.body as LoginResponseBody;

    expect(typeof body.accessToken).toBe('string');

    const jwt = app.get(JwtService);
    const payload = await jwt.verifyAsync<{ sub: string; email: string }>(
      body.accessToken,
    );
    expect(payload.email).toBe(email);
    expect(typeof payload.sub).toBe('string');
  });

  it('rejects login with the wrong password with 401', async () => {
    const email = `${Date.now()}@example.test`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'correct horse battery' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'the wrong password' })
      .expect(401);
  });

  it('rejects login for a nonexistent email with 401, same as a wrong password', async () => {
    // Same status/shape as the wrong-password case (see AuthService.login) — a
    // different response here would let a caller enumerate registered emails.
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: `${Date.now()}@nonexistent.test`, password: 'whatever' })
      .expect(401);
  });

  // GET /auth/me is JwtAuthGuard's first real use (SCRUM-38) — never actually
  // exercised by a test until now. Worth being explicit: this proves the guard's
  // dependency (JwtService) actually resolves via AuthModule's DI graph at runtime,
  // not just that the code compiles.
  it('returns the authenticated user via /auth/me with a valid token', async () => {
    const email = `${Date.now()}@example.test`;
    const password = 'correct horse battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    const loginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const { accessToken } = loginResponse.body as LoginResponseBody;

    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const body = response.body as { sub: string; email: string };

    expect(body.email).toBe(email);
    expect(typeof body.sub).toBe('string');
  });

  it('rejects /auth/me with no Authorization header', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
  });

  it('rejects /auth/me with a garbage token', async () => {
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer not-a-real-jwt')
      .expect(401);
  });
});
