import { validateEnv } from './env.validation';

const productionEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pass@host:5432/edugear',
  JWT_ACCESS_SECRET: 'a-production-secret-that-is-long-enough-to-pass',
  CORS_ORIGINS: 'https://app.edugear.test',
  REDIS_URL: 'redis://cache:6379',
};

function envWithout(key: keyof typeof productionEnv): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...productionEnv };
  delete copy[key];
  return copy;
}

describe('validateEnv', () => {
  it('accepts a complete production environment', () => {
    expect(() => validateEnv({ ...productionEnv })).not.toThrow();
  });

  it('refuses to boot production without Redis', () => {
    // Falling back to per-instance rate limiting and permission caching is a
    // silent correctness loss the moment a second instance exists, so it must
    // fail at boot rather than at runtime.
    expect(() => validateEnv(envWithout('REDIS_URL'))).toThrow(
      /REDIS_URL is required in production/,
    );
  });

  it('allows development and test to run without Redis', () => {
    const base = envWithout('REDIS_URL');

    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'development' }),
    ).not.toThrow();
    expect(() => validateEnv({ ...base, NODE_ENV: 'test' })).not.toThrow();
  });

  it('defaults the Redis key prefix', () => {
    expect(validateEnv({ ...productionEnv }).REDIS_KEY_PREFIX).toBe('edugear:');
  });
});
