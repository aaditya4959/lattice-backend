import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module';
import { SyncModule } from '../sync/sync.module';
import { HealthController } from './health.controller';

// Imports SyncModule wholesale for its exported REDIS_PUBLISHER, rather than
// factoring redis.provider.ts out into its own module — matches the existing pattern
// of importing a whole domain module for one piece of it (e.g. SyncModule already
// imports AuthModule/DocsModule this way).
@Module({
  imports: [PersistenceModule, SyncModule],
  controllers: [HealthController],
})
export class HealthModule {}
