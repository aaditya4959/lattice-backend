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
})
export class DocsModule {}
