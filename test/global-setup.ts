import { execSync } from 'node:child_process';
import * as path from 'node:path';

/** Applies migrations to the test database once per `npm run test:e2e`. */
export default function globalSetup(): void {
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
}
