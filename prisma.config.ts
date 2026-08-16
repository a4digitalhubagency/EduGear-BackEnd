import * as path from 'node:path';
import { defineConfig } from 'prisma/config';

// A prisma.config.ts file disables Prisma's implicit .env loading, so do it explicitly.
// Node's built-in loader keeps us free of a dotenv dependency.
for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(path.join(process.cwd(), file));
  } catch {
    // File absent — fine in CI/production where env vars are injected by the platform.
  }
}

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    seed: 'ts-node --compiler-options {"module":"CommonJS"} prisma/seed.ts',
  },
});
