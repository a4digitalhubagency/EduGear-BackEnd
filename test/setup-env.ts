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

// Uploads land in a throwaway directory, never in the repo.
process.env.STORAGE_LOCAL_DIR = path.join(
  process.env.TMPDIR ?? '/tmp',
  'edugear-test-storage',
);
// StorageService prefers R2 the moment all four of these are present, and a
// developer with real credentials in .env would otherwise have the suite write
// its ELF headers, fake JPEGs and multi-megabyte quota fixtures into a real
// bucket. Same reasoning as forcing DATABASE_URL above: the tests get a
// throwaway, never the live thing.
//
// Emptied rather than deleted, and the difference matters. Deleting them left a
// hole that anything loading .env later would fill, and something does:
// importing src/app.module pulls in Prisma Client, which reads .env on import,
// long after this file has run. A developer with real credentials in .env had
// the whole integration suite writing its fixtures into the live bucket and
// failing on that bucket's network errors, which read as flaky tests.
//
// An empty value cannot be refilled, because every loader involved declines to
// overwrite a variable that is already present, and StorageService treats a
// blank credential as absent. test-app.ts asserts the driver that results, so
// this cannot quietly come undone again.
for (const key of [
  'R2_BUCKET',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  // Likewise: a test run must never file issues in the real Sentry project.
  'SENTRY_DSN',
]) {
  process.env[key] = '';
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
