import { Module } from '@nestjs/common';
import { ConnectionRegistryService } from './connection-registry.service';
import { DocRegistryService } from './doc-registry.service';
import { RedisFanoutService } from './redis-fanout.service';
import { redisProviders } from './redis.provider';
import { SyncGateway } from './sync.gateway';

@Module({
  providers: [
    SyncGateway,
    DocRegistryService,
    ConnectionRegistryService,
    RedisFanoutService,
    ...redisProviders,
  ],
})
export class SyncModule {}
