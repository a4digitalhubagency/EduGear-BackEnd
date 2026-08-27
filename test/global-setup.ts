import { execSync } from 'node:child_process';
import * as path from 'node:path';
import Redis from 'ioredis';
import { testRedisUrl } from './utils/redis-url';

/**
 * Applies migrations to the test database and clears the test Redis database
 * once per `npm run test:e2e`.
 */
export default async function globalSetup(): Promise<void> {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(path.join(process.cwd(), file));
    } catch {
      // Not present in CI.
    }
  }

  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error('TEST_DATABASE_URL must be set to run integration tests');
  }

  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testUrl, DIRECT_URL: testUrl },
  });

  // Stale rate-limit counters would fail the rate-limit suite on a second run
  // inside the throttle window. Scoped to TEST_REDIS_DB — never db 0.
  const redisUrl = testRedisUrl(process.env.REDIS_URL);
  if (redisUrl) {
    const client = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    try {
      await client.flushdb();
    } finally {
      await client.quit();
    }
  }
}
