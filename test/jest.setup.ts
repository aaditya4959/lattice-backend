// Swaps `ioredis` for `ioredis-mock` at the module-loader level, for every e2e spec —
// this is ioredis-mock's own documented integration pattern, not a project-specific
// workaround. See src/sync/redis.provider.ts for why application code has no
// test-mode branch of its own.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-return
jest.mock('ioredis', () => require('ioredis-mock'));
