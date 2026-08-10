import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { ConnectionRegistryService } from './connection-registry.service';
import { DocRegistryService } from './doc-registry.service';
import { RedisFanoutService } from './redis-fanout.service';
import { redisProviders } from './redis.provider';
import { SyncGateway } from './sync.gateway';

@Module({
  // AuthModule exports JwtModule — SyncGateway needs JwtService to validate `join`'s
  // token (SCRUM-38).
  imports: [PersistenceModule, AuthModule],
  providers: [
    SyncGateway,
    DocRegistryService,
    ConnectionRegistryService,
    RedisFanoutService,
    ...redisProviders,
  ],
})
export class SyncModule {}
