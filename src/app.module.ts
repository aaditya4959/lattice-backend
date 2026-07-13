import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { DocsModule } from './docs/docs.module';
import { SyncModule } from './sync/sync.module';
import { PersistenceModule } from './persistence/persistence.module';

@Module({
  imports: [AuthModule, DocsModule, SyncModule, PersistenceModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
