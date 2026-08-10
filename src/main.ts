import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // whitelist: strips unknown body properties rather than erroring or silently
  // passing them through. transform: constructs actual DTO class instances (some
  // validators need this) rather than leaving req.body as a plain object.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Raw `ws` per ADR-0002, not the default (socket.io-based) adapter.
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
