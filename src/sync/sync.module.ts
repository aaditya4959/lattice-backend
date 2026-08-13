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

// Placeholder default, not a tuned value — same caveat as SNAPSHOT_INTERVAL_MS
// (persistence.module.ts): DESIGN.md §8 flags this kind of interval as needing
// empirical tuning once load-testing is in place.
const cursorThrottleIntervalProvider: Provider = {
  provide: CURSOR_THROTTLE_MS,
  useValue: Number(process.env.CURSOR_THROTTLE_MS ?? 100),
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
})
export class SyncModule {}
