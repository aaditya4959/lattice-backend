import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { DocsController } from './docs.controller';
import { DocsService } from './docs.service';

@Module({
  // AuthModule exports JwtAuthGuard (SCRUM-38) — DocsController uses it directly.
  imports: [PersistenceModule, AuthModule],
  controllers: [DocsController],
  providers: [DocsService],
  // DocsService exported so SyncModule (SCRUM-41) can authorize `join` against real
  // doc ownership/collaboration without going through HTTP.
  exports: [DocsService],
})
export class DocsModule {}
