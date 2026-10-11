/**
 * Checks a database URL before an environment is pointed at it.
 *
 *   DB_URL="postgresql://…" npx ts-node scripts/check-database.ts
 *   DB_URL="…" DB_DIRECT_URL="…" npx ts-node scripts/check-database.ts
 *
 * Read from the environment rather than argv on purpose: an argument lands in
 * shell history and in `ps` output for every user on the machine.
 *
 * Nothing here writes. It answers the questions worth answering before a first
 * deploy: can we reach it, is it a version we support, is it actually empty,
 * and is the direct URL genuinely unpooled — because Prisma runs migrations
 * over that one, and a pooled connection is the classic way that fails.
 */
import { PrismaClient } from '@prisma/client';

const MIN_MAJOR = 14;

/**
 * Prisma's connection failures say "Invalid `prisma.$queryRaw()` invocation" on
 * the first line and bury the cause. These codes are the ones a wrong
 * connection string actually produces, so say what they mean.
 */
const CAUSES: Record<string, string> = {
  P1000: 'authentication failed — the user or password in the URL is wrong',
  P1001:
    'cannot reach the server — check the host, the port, and whether your IP is allowed',
  P1002: 'the server is reachable but timed out',
  P1003: 'that database does not exist on the server',
  P1010: 'the server refused this user access',
  P1011: 'TLS error — Neon needs sslmode=require in the URL',
  P1013: 'the connection string is malformed',
  P1017: 'the server closed the connection',
};

/** Prisma errors are multi-line and can quote the connection string back. */
function explain(error: unknown): string {
  const code =
    (error as { errorCode?: string; code?: string })?.errorCode ??
    (error as { code?: string })?.code;
  if (code && CAUSES[code]) return `${CAUSES[code]} (${code})`;

  const raw = error instanceof Error ? error.message : String(error);
  const line =
    raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('Invalid `prisma')) ??
    'no detail given';
  // Never print a password, whatever the driver decided to include.
  return line.replace(/:\/\/[^@\s]*@/g, '://***:***@');
}

async function inspect(label: string, url: string): Promise<boolean> {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const [{ version }] = await prisma.$queryRaw<{ version: string }[]>`
      SELECT version()`;
    const [{ name }] = await prisma.$queryRaw<{ name: string }[]>`
      SELECT current_database() AS name`;
    const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM information_schema.tables
      WHERE table_schema = 'public'`;

    const major = Number(/PostgreSQL (\d+)/.exec(version)?.[1] ?? 0);
    const host = new URL(url).host;

    console.log(`\n${label}`);
    console.log(`  host      : ${host}`);
    console.log(`  database  : ${name}`);
    console.log(
      `  version   : PostgreSQL ${major}  ${major >= MIN_MAJOR ? 'OK' : `TOO OLD (need ${MIN_MAJOR}+)`}`,
    );
    console.log(
      `  tables    : ${count} in public  ${count === 0n ? '(empty — a fresh database)' : '(NOT empty — check this is the right one)'}`,
    );
    console.log(`  pooled    : ${host.includes('-pooler') ? 'yes' : 'no'}`);
    return true;
  } catch (error) {
    // Named, so it is obvious which of the two URLs is the broken one.
    console.log(`\n${label}`);
    console.log(`  host      : ${safeHost(url)}`);
    console.log(`  FAILED    : ${explain(error)}`);
    return false;
  } finally {
    await prisma.$disconnect();
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(not a valid URL — check for a stray quote or line break)';
  }
}

async function main(): Promise<void> {
  const url = process.env.DB_URL;
  const direct = process.env.DB_DIRECT_URL;
  if (!url) {
    console.error('Set DB_URL (and optionally DB_DIRECT_URL).');
    process.exit(1);
  }

  const appOk = await inspect('DATABASE_URL (the app uses this)', url);
  if (direct) {
    const directOk = await inspect('DIRECT_URL (migrations use this)', direct);
    if (!appOk || !directOk) process.exitCode = 1;

    const pooled = new URL(url).host.includes('-pooler');
    const directPooled = new URL(direct).host.includes('-pooler');
    console.log('\nverdict');
    if (directPooled) {
      console.log(
        '  DIRECT_URL points at the POOLER. Migrations should use the',
      );
      console.log('  unpooled host — take the one without "-pooler" in it.');
    } else if (!pooled) {
      console.log(
        '  Neither URL is pooled. Workable, but DATABASE_URL should be the',
      );
      console.log(
        '  pooled one so the app survives more concurrent connections.',
      );
    } else {
      console.log('  Correct: pooled for the app, unpooled for migrations.');
    }
  } else {
    console.log(
      '\nNo DB_DIRECT_URL given — set it too, migrations need the unpooled host.',
    );
  }
}

main().catch((error: unknown) => {
  console.error(
    '\nCould not connect:',
    error instanceof Error ? error.message.split('\n')[0] : error,
  );
  process.exit(1);
});
