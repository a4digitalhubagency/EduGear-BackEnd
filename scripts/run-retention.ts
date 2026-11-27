/**
 * Applies the data retention schedule.
 *
 *   npm run retention:preview          # what a run would destroy. Changes nothing.
 *   npm run retention:run -- --execute # actually do it
 *   npm run retention:preview -- --task students.minimise
 *
 * **Preview is the default and `--execute` is required**, because every task
 * here destroys data about children and none of it comes back. If you have not
 * read a preview, you are not ready to run this.
 *
 * It prints which database it is about to touch before touching it, for the
 * same reason `platform:grant` does: the environments differ by one word in
 * `DATABASE_URL`, and getting it wrong is silent until it is catastrophic.
 *
 * There is deliberately no scheduler wired to this. A cron job whose first act
 * is to destroy records on a timer is not something to add on the same day you
 * write the records. Run it by hand, read the output, and automate it once the
 * preview has been boring for a few months.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(path.join(process.cwd(), file));
  } catch {
    // Absent is fine; the variables may come from the environment.
  }
}

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const taskIndex = args.indexOf('--task');
const task = taskIndex >= 0 ? args[taskIndex + 1] : undefined;

/** Prints where we are about to write, and how much is in it. */
async function describeTarget(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  const redacted = url.replace(/\/\/[^@]*@/, '//***@');
  const shown = redacted.split('?')[0] || '(DATABASE_URL not set)';

  const prisma = new PrismaClient();
  try {
    const [schools, students] = await Promise.all([
      prisma.school.count(),
      prisma.student.count(),
    ]);
    console.log(`\n  Database:  ${shown}`);
    console.log(`  Contains:  ${schools} school(s), ${students} student(s)`);
  } catch (error) {
    console.log(`\n  Database:  ${shown}`);
    console.log(`  Contains:  (could not read — ${String(error)})`);
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  if (task && !args[taskIndex + 1]) {
    console.error('--task needs a task name, e.g. --task students.minimise');
    process.exit(1);
  }

  await describeTarget();
  console.log(
    `  Mode:      ${execute ? 'EXECUTE — this destroys data' : 'preview (nothing will change)'}`,
  );
  console.log(`  Tasks:     ${task ?? 'all'}\n`);

  // Imported here so the env loading above happens before Prisma is pulled in.
  const { AppModule } = await import('../src/app.module');
  const { RetentionService } =
    await import('../src/retention/retention.service');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const retention = app.get(RetentionService);
    const result = execute
      ? await retention.run(task)
      : await retention.preview(task);

    const width = Math.max(
      ...result.tasks.map((t) => t.task.length),
      'TASK'.length,
    );
    console.log(`  ${'TASK'.padEnd(width)}   ROWS   CUTOFF`);
    console.log(`  ${'-'.repeat(width)}   ----   ------`);

    for (const entry of result.tasks) {
      const rows = String(entry.affected).padStart(4);
      const cutoff = entry.cutoff.toISOString().slice(0, 10);
      const flag = entry.error ? `  FAILED: ${entry.error}` : '';
      console.log(`  ${entry.task.padEnd(width)}   ${rows}   ${cutoff}${flag}`);
    }

    const failures = result.tasks.filter((t) => t.error).length;
    console.log(
      `\n  ${result.executed ? 'Destroyed' : 'Would affect'} ${result.totalAffected} record(s) across ${result.tasks.length} task(s).`,
    );

    if (!execute && result.totalAffected > 0) {
      console.log('  Re-run with --execute to apply.\n');
    } else {
      console.log('');
    }

    if (failures > 0) {
      console.error(`  ${failures} task(s) failed — see above.\n`);
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  Logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
