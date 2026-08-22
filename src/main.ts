import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { requireEnv } from './config/require-env';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // whitelist: strips unknown body properties rather than erroring or silently
  // passing them through. transform: constructs actual DTO class instances (some
  // validators need this) rather than leaving req.body as a plain object.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Explicit allowlist, not `origin: '*'` — this API hands out bearer tokens, and an
  // allowlist costs nothing extra to maintain (one env var) while being the safer
  // default. Comma-separated so a real frontend deployment can be added alongside
  // local dev without a code change. Uses requireEnv so a real deployment can't
  // silently ship allowing only the dev fallback — same fail-fast-outside-dev
  // philosophy as JWT_SECRET/DATABASE_URL/REDIS_URL (SCRUM-54). Only affects the
  // REST endpoints (`/auth/*`, `/docs/*`, `/health`) — the `/sync` WebSocket gateway
  // isn't subject to CORS at all (browsers don't apply the same-origin restriction
  // to WebSocket handshakes the way they do to fetch/XHR).
  const corsOrigins = requireEnv(
    'CORS_ORIGINS',
    'http://localhost:3000,http://localhost:3001',
  )
    .split(',')
    .map((origin) => origin.trim());
  app.enableCors({ origin: corsOrigins });

  // Raw `ws` per ADR-0002, not the default (socket.io-based) adapter.
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
