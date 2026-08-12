import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DocsModule } from '../docs/docs.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { ConnectionRegistryService } from './connection-registry.service';
import { DocRegistryService } from './doc-registry.service';
import { RedisFanoutService } from './redis-fanout.service';
import { redisProviders } from './redis.provider';
import { SyncGateway } from './sync.gateway';

@Module({
  // AuthModule exports JwtModule — SyncGateway needs JwtService to validate `join`'s
  // token (SCRUM-38). DocsModule exports DocsService — SyncGateway needs it to
  // authorize `join` against real doc ownership/collaboration (SCRUM-41).
  imports: [PersistenceModule, AuthModule, DocsModule],
  providers: [
    SyncGateway,
    DocRegistryService,
    ConnectionRegistryService,
    RedisFanoutService,
    ...redisProviders,
  ],
})
export class SyncModule {}
