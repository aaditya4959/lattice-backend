import { Module, Provider } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DocsModule } from '../docs/docs.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { ConnectionRegistryService } from './connection-registry.service';
import {
  CURSOR_THROTTLE_MS,
  CursorThrottleService,
} from './cursor-throttle.service';
import { DocRegistryService } from './doc-registry.service';
import { PresenceRegistryService } from './presence-registry.service';
import { RedisFanoutService } from './redis-fanout.service';
import { redisProviders } from './redis.provider';
import { SyncGateway } from './sync.gateway';

// Tuned via SCRUM-58's k6 load test (load-test/sync-load-test.js), not the original
// placeholder — 50ms held up cleanly (zero errors, ~1800 cursor messages/s received
// server-wide) at double the concurrency the untuned 100ms default was ever exercised
// against; server capacity was never the real constraint at this scale. 75ms is
// meaningfully smoother live-cursor feedback than the old 100ms while keeping margin
// above the tested 50ms floor — the actual choice of exactly how smooth is a UX
// judgment a load test alone can't make, same caveat as auth.module.ts's rate-limit
// threshold. See load-test/README.md.
const cursorThrottleIntervalProvider: Provider = {
  provide: CURSOR_THROTTLE_MS,
  useValue: Number(process.env.CURSOR_THROTTLE_MS ?? 75),
};

@Module({
  // AuthModule exports JwtModule — SyncGateway needs JwtService to validate `join`'s
  // token (SCRUM-38). DocsModule exports DocsService — SyncGateway needs it to
  // authorize `join` against real doc ownership/collaboration (SCRUM-41).
  imports: [PersistenceModule, AuthModule, DocsModule],
  providers: [
    SyncGateway,
    DocRegistryService,
    ConnectionRegistryService,
    PresenceRegistryService,
    CursorThrottleService,
    cursorThrottleIntervalProvider,
    RedisFanoutService,
    ...redisProviders,
  ],
  // redisProviders exported so HealthModule (SCRUM-57) can inject REDIS_PUBLISHER for
  // a connectivity ping without a separate RedisModule just for two provider lines.
  exports: [...redisProviders],
})
export class SyncModule {}
