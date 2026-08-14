import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { requireEnv } from '../config/require-env';
import { PersistenceModule } from '../persistence/persistence.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { UsersService } from './users.service';

@Module({
  imports: [
    PersistenceModule,
    JwtModule.register({
      // Dev-only fallback — matches the pattern used for REDIS_URL/DATABASE_URL
      // (redis.provider.ts, postgres.provider.ts). Outside a recognized dev/test
      // NODE_ENV, requireEnv() refuses to fall back at all (SCRUM-54, closing the gap
      // docs/adr/0006-auth-strategy.md's Consequences flagged for all three together).
      secret: requireEnv(
        'JWT_SECRET',
        'dev-only-insecure-secret-do-not-use-in-production',
      ),
      signOptions: { expiresIn: '24h' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, UsersService, JwtAuthGuard],
  // JwtAuthGuard exported explicitly (not left to Nest's implicit class-reference
  // resolution) so other modules importing AuthModule — DocsModule, SCRUM-39 — can
  // reliably use `@UseGuards(JwtAuthGuard)` with its JwtService dependency resolved.
  // UsersService exported too (SCRUM-40) — DocsService needs findByEmail() to resolve
  // an invite target.
  exports: [JwtModule, JwtAuthGuard, UsersService],
})
export class AuthModule {}
