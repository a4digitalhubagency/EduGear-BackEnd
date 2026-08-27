import * as path from 'node:path';
import { testRedisUrl } from './utils/redis-url';

// Load developer .env first; explicit values below always win because
// process.loadEnvFile never overrides variables already present.
for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(path.join(process.cwd(), file));
  } catch {
    // Absent in CI, where variables come from the workflow.
  }
}

process.env.NODE_ENV = 'test';
// Integration tests run against a throwaway database — never the dev one.
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error('TEST_DATABASE_URL must be set to run integration tests');
}
process.env.DATABASE_URL = testUrl;
process.env.DIRECT_URL = testUrl;

// Redis stays optional: without it the app falls back to per-instance state and
// the suites still pass. When present, tests are pinned to their own database.
const redisUrl = testRedisUrl(process.env.REDIS_URL);
if (redisUrl) {
  process.env.REDIS_URL = redisUrl;
} else {
  delete process.env.REDIS_URL;
}

process.env.EMAIL_PROVIDER = 'console';
// Rate limiting has a dedicated suite (rate-limit.e2e-spec.ts, which sets its own
// limits before loading the app); everywhere else it must not interfere. These
// overwrite whatever .env holds, hence no `??`.
process.env.THROTTLE_LIMIT = '100000';
process.env.AUTH_THROTTLE_LIMIT = '100000';
process.env.STRICT_THROTTLE_LIMIT = '100000';
process.env.LOG_LEVEL = 'silent';
process.env.SWAGGER_ENABLED = 'false';
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ??
  'test-secret-value-that-is-long-enough-to-pass-validation';
