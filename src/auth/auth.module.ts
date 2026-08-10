import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PersistenceModule } from '../persistence/persistence.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { UsersService } from './users.service';

@Module({
  imports: [
    PersistenceModule,
    JwtModule.register({
      // Dev-only fallback — matches the pattern already used for REDIS_URL/DATABASE_URL
      // (redis.provider.ts, postgres.provider.ts). Must be set to a real secret outside
      // local dev; see docs/adr/0006-auth-strategy.md (SCRUM-42) for the full picture.
      secret:
        process.env.JWT_SECRET ??
        'dev-only-insecure-secret-do-not-use-in-production',
      signOptions: { expiresIn: '24h' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, UsersService, JwtAuthGuard],
  // JwtAuthGuard exported explicitly (not left to Nest's implicit class-reference
  // resolution) so other modules importing AuthModule — DocsModule, SCRUM-39 — can
  // reliably use `@UseGuards(JwtAuthGuard)` with its JwtService dependency resolved.
  exports: [JwtModule, JwtAuthGuard],
})
export class AuthModule {}
