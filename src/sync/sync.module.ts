import { Module } from '@nestjs/common';
import { DocRegistryService } from './doc-registry.service';
import { SyncGateway } from './sync.gateway';

@Module({
  providers: [SyncGateway, DocRegistryService],
})
export class SyncModule {}
