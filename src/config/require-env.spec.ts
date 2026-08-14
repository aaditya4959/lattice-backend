import { requireEnv } from './require-env';

const ENV_VAR = 'REQUIRE_ENV_SPEC_TEST_VAR';

describe('requireEnv', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    delete process.env[ENV_VAR];
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns the env var when set, regardless of NODE_ENV', () => {
    process.env[ENV_VAR] = 'explicit-value';
    process.env.NODE_ENV = 'production';
    expect(requireEnv(ENV_VAR, 'fallback')).toBe('explicit-value');
  });

  it.each(['development', 'test', ''])(
    'falls back to the dev default when unset and NODE_ENV=%p',
    (nodeEnv) => {
      delete process.env[ENV_VAR];
      process.env.NODE_ENV = nodeEnv;
      expect(requireEnv(ENV_VAR, 'fallback')).toBe('fallback');
    },
  );

  it('falls back to the dev default when unset and NODE_ENV is itself unset', () => {
    delete process.env[ENV_VAR];
    delete process.env.NODE_ENV;
    expect(requireEnv(ENV_VAR, 'fallback')).toBe('fallback');
  });

  it.each(['production', 'staging'])(
    'refuses to fall back when unset and NODE_ENV=%p',
    (nodeEnv) => {
      delete process.env[ENV_VAR];
      process.env.NODE_ENV = nodeEnv;
      expect(() => requireEnv(ENV_VAR, 'fallback')).toThrow(ENV_VAR);
    },
  );
});
