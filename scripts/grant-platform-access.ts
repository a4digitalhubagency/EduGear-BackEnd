/**
 * Bootstraps the first platform owner, and grants access later without a console.
 *
 *   npx ts-node scripts/grant-platform-access.ts ops@a4technologies.ng OWNER
 *   npx ts-node scripts/grant-platform-access.ts ops@a4technologies.ng OWNER --reset-password
 *
 * It prints which database it is about to write to before it writes anything.
 * The environments differ by one word in an environment variable, and getting
 * it wrong is silent: the grant succeeds and the console still refuses you,
 * because the row went somewhere nothing reads.
 *
 * A script rather than an env var read at boot: an auto-promoting variable is a
 * standing backdoor, and one that would be re-applied on every deploy. This runs
 * when a person decides to run it, and prints exactly what it changed.
 *
 * The account must already exist and must belong to no school — the same rule
 * the API enforces, for the same reason.
 */
import { PlatformRole, PrismaClient, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(path.join(process.cwd(), file));
  } catch {
    // Absent is fine; the variables may come from the environment.
  }
}

const prisma = new PrismaClient();

function usage(message: string): never {
  console.error(`\n${message}\n`);
  console.error(
    'Usage: npx ts-node scripts/grant-platform-access.ts <email> [SUPPORT|OPERATOR|OWNER] [--create] [--reset-password]\n',
  );
  console.error(
    '  --create           make the account too, printing a random password',
  );
  console.error(
    '  --reset-password   set a new random password on an existing account',
  );
  process.exit(1);
}

/**
 * Says which database is about to be written to, before anything is.
 *
 * This script is pointed at a database by an environment variable typed on a
 * command line, and the two environments differ by one word. Getting it wrong
 * is silent: the grant succeeds, the account exists, and the thing you are
 * trying to administer carries on refusing you — because the row went
 * somewhere nothing reads. That happened, and it cost an hour to find.
 *
 * So: host, database, and how many users are already there. A staging database
 * has a seeded school's worth of staff in it; an empty one is the tell that
 * you are somewhere you did not mean to be.
 */
async function describeTarget(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  let where = '(unparseable DATABASE_URL)';
  try {
    const parsed = new URL(url);
    // Never the credentials — this is printed, and printed things get pasted.
    where = `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    // Left as the placeholder; the connection will fail and say so.
  }

  const [users, admins] = await Promise.all([
    prisma.user.count(),
    prisma.platformAdmin.count(),
  ]);

  console.log(`Database:  ${where}`);
  console.log(`Contains:  ${users} user(s), ${admins} platform admin(s)`);
  console.log();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const email = args[0]?.trim().toLowerCase();
  const role = (args[1] ?? 'OWNER').toUpperCase() as PlatformRole;
  const create = args.includes('--create');
  const resetPassword = args.includes('--reset-password');

  if (!email || !email.includes('@')) usage('An email address is required.');
  if (!Object.values(PlatformRole).includes(role)) {
    usage(`Unknown role "${role}".`);
  }

  await describeTarget();

  let user = await prisma.user.findUnique({
    where: { email },
    include: {
      platformAdmin: true,
      _count: { select: { memberships: true } },
    },
  });

  if (!user && !create) {
    usage(
      `No user with email ${email}. Re-run with --create to make the account.`,
    );
  }

  let generatedPassword: string | undefined;
  if (!user) {
    generatedPassword = randomBytes(18).toString('base64url');
    const created = await prisma.user.create({
      data: {
        email,
        firstName: 'Platform',
        lastName: 'Operator',
        passwordHash: await argon2.hash(generatedPassword, {
          type: argon2.argon2id,
        }),
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
      },
    });
    user = { ...created, platformAdmin: null, _count: { memberships: 0 } };
  }

  if (user._count.memberships > 0) {
    usage(
      `${email} belongs to ${user._count.memberships} school(s). Platform ` +
        'access must use a separate account, so a compromised school login ' +
        'cannot reach the platform.',
    );
  }

  if (resetPassword && !generatedPassword) {
    // Recovering an account nobody can get into. The alternative was writing
    // an argon2 hash by hand and running an UPDATE against production, which
    // is not a procedure anybody should be improvising at the time they most
    // need it to work.
    generatedPassword = randomBytes(18).toString('base64url');
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await argon2.hash(generatedPassword, {
          type: argon2.argon2id,
        }),
        // A locked-out account is usually why somebody is running this.
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
  }

  if (user.platformAdmin) {
    // Idempotent: re-running promotes or re-enables rather than failing.
    await prisma.platformAdmin.update({
      where: { id: user.platformAdmin.id },
      data: { role, disabledAt: null },
    });
    const wasDisabled = user.platformAdmin.disabledAt !== null;
    console.log(
      `Updated ${email} to ${role} platform access.` +
        // Worth saying out loud: a disabled account is refused at login with
        // the same message as a wrong password, so "it still will not let me
        // in" and "it was switched off" look identical from outside.
        (wasDisabled ? ' It was disabled, and is now enabled again.' : ''),
    );
  } else {
    await prisma.platformAdmin.create({ data: { userId: user.id, role } });
    console.log(`Granted ${role} platform access to ${email}.`);
  }

  if (generatedPassword) {
    console.log(`\n  Password: ${generatedPassword}`);
    console.log('  Change it after the first sign-in.\n');
  }

  const owners = await prisma.platformAdmin.count({
    where: { role: PlatformRole.OWNER, disabledAt: null },
  });
  console.log(`Active platform owners: ${owners}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
