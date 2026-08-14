import { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { requireEnv } from '../config/require-env';

export const REDIS_PUBLISHER = Symbol('REDIS_PUBLISHER');
export const REDIS_SUBSCRIBER = Symbol('REDIS_SUBSCRIBER');

function createRedisClient(): Redis {
  return new Redis(requireEnv('REDIS_URL', 'redis://localhost:6379'));
}

/**
 * Two separate connections, not one: once a Redis connection issues SUBSCRIBE, the
 * Redis protocol restricts it to pub/sub commands only — PUBLISH would fail on it.
 * This is a real protocol constraint, not a design preference.
 *
 * This always constructs a real `ioredis.Redis` — application code has no test-mode
 * branch. Tests swap the underlying `ioredis` module for `ioredis-mock` at Jest's
 * module-loader level instead (`test/jest.setup.ts`, via `jest.mock('ioredis', () =>
 * require('ioredis-mock'))`, which is ioredis-mock's own documented integration
 * pattern), so no real Redis server is needed for `npm run test:e2e` and this file
 * never has to know it's under test.
 *
 * Ticket: SCRUM-29 (LAT-E1B)
 */
export const redisProviders: Provider[] = [
  { provide: REDIS_PUBLISHER, useFactory: createRedisClient },
  { provide: REDIS_SUBSCRIBER, useFactory: createRedisClient },
];
