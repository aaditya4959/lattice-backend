import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { Pool } from 'pg';
import { PG_POOL } from '../persistence/postgres.provider';
import { REDIS_PUBLISHER } from '../sync/redis.provider';

interface HealthCheckResult {
  status: 'ok' | 'error';
  postgres: string;
  redis: string;
}

/**
 * For a real deployment's orchestrator (load balancer, ECS, k8s) to check whether an
 * instance can actually serve traffic — reaching Postgres and Redis, not just "the
 * HTTP server accepted this connection." Unauthenticated: orchestrators generally
 * can't hold a user JWT, and a health check reveals nothing more sensitive than a
 * TCP-level check already would.
 *
 * Ticket: SCRUM-57 (LAT-E6)
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS_PUBLISHER) private readonly redis: Redis,
  ) {}

  @Get()
  async check(): Promise<HealthCheckResult> {
    const [postgres, redis] = await Promise.all([
      this.checkPostgres(),
      this.checkRedis(),
    ]);
    const result: HealthCheckResult = {
      status: postgres === 'ok' && redis === 'ok' ? 'ok' : 'error',
      postgres,
      redis,
    };

    // A 503 needs to be thrown, not returned — Nest always sends a normal handler's
    // return value with the success status code (200 for a plain @Get()), regardless
    // of what the body says.
    if (result.status === 'error') {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }

  private async checkPostgres(): Promise<string> {
    try {
      await this.pool.query('SELECT 1');
      return 'ok';
    } catch (err) {
      return `unreachable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async checkRedis(): Promise<string> {
    try {
      await this.redis.ping();
      return 'ok';
    } catch (err) {
      return `unreachable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
