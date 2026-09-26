/**
 * Bootstraps the first platform owner, and grants access later without a console.
 *
 *   npx ts-node scripts/grant-platform-access.ts ops@a4technologies.ng OWNER
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
    'Usage: npx ts-node scripts/grant-platform-access.ts <email> [SUPPORT|OPERATOR|OWNER] [--create]\n',
  );
  console.error(
    '  --create   make the account too, printing a random password',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const email = args[0]?.trim().toLowerCase();
  const role = (args[1] ?? 'OWNER').toUpperCase() as PlatformRole;
  const create = args.includes('--create');

  if (!email || !email.includes('@')) usage('An email address is required.');
  if (!Object.values(PlatformRole).includes(role)) {
    usage(`Unknown role "${role}".`);
  }

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

  if (user.platformAdmin) {
    // Idempotent: re-running promotes or re-enables rather than failing.
    await prisma.platformAdmin.update({
      where: { id: user.platformAdmin.id },
      data: { role, disabledAt: null },
    });
    console.log(`Updated ${email} to ${role} platform access.`);
  } else {
    await prisma.platformAdmin.create({ data: { userId: user.id, role } });
    console.log(`Granted ${role} platform access to ${email}.`);
  }

  if (generatedPassword) {
    console.log(`\n  Account created. Password: ${generatedPassword}`);
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
