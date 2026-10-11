/**
 * Development seed. Idempotent: safe to run repeatedly.
 *
 * Creates the permission catalogue (also synced automatically on app boot) and
 * two demo schools — two tenants make cross-tenant mistakes visible immediately
 * during manual testing.
 */
import {
  MembershipStatus,
  PrismaClient,
  SchoolStatus,
  UserStatus,
} from '@prisma/client';
import * as argon2 from 'argon2';
import {
  ALL_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  permissionGroup,
} from '../src/common/constants/permissions';
import {
  SYSTEM_ROLE_DEFINITIONS,
  SystemRoleSlug,
} from '../src/common/constants/roles';

const prisma = new PrismaClient();

// Must satisfy the password policy in PasswordService.assertMeetsPolicy.
const DEMO_PASSWORD = 'Demo9Access2026';

async function syncPermissions(): Promise<void> {
  for (const key of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      create: {
        key,
        group: permissionGroup(key),
        description: PERMISSION_DESCRIPTIONS[key],
      },
      update: {
        group: permissionGroup(key),
        description: PERMISSION_DESCRIPTIONS[key],
      },
    });
  }
  console.log(`✓ ${ALL_PERMISSIONS.length} permissions synced`);
}

async function seedSchool(input: {
  name: string;
  slug: string;
  email: string;
  city: string;
  state: string;
  staff: {
    email: string;
    firstName: string;
    lastName: string;
    role: SystemRoleSlug;
  }[];
}): Promise<void> {
  const existing = await prisma.school.findUnique({
    where: { slug: input.slug },
  });
  if (existing) {
    console.log(`• ${input.name} already seeded — skipping`);
    return;
  }

  const permissions = await prisma.permission.findMany();
  const permissionIdByKey = new Map(permissions.map((p) => [p.key, p.id]));
  const passwordHash = await argon2.hash(DEMO_PASSWORD, {
    type: argon2.argon2id,
  });

  await prisma.$transaction(async (tx) => {
    const school = await tx.school.create({
      data: {
        name: input.name,
        slug: input.slug,
        email: input.email,
        city: input.city,
        state: input.state,
        status: SchoolStatus.ACTIVE,
      },
    });

    const roleIdBySlug = new Map<string, string>();

    for (const definition of SYSTEM_ROLE_DEFINITIONS) {
      const role = await tx.role.create({
        data: {
          schoolId: school.id,
          name: definition.name,
          slug: definition.slug,
          description: definition.description,
          isSystem: true,
        },
      });
      roleIdBySlug.set(definition.slug, role.id);

      await tx.rolePermission.createMany({
        data: definition.permissions
          .map((key) => permissionIdByKey.get(key))
          .filter((id): id is string => Boolean(id))
          .map((permissionId) => ({ roleId: role.id, permissionId })),
        skipDuplicates: true,
      });
    }

    for (const [index, member] of input.staff.entries()) {
      const user = await tx.user.upsert({
        where: { email: member.email },
        create: {
          email: member.email,
          firstName: member.firstName,
          lastName: member.lastName,
          passwordHash,
          status: UserStatus.ACTIVE,
          emailVerifiedAt: new Date(),
        },
        update: {},
      });

      await tx.membership.create({
        data: {
          userId: user.id,
          schoolId: school.id,
          roleId: roleIdBySlug.get(member.role)!,
          status: MembershipStatus.ACTIVE,
          isDefault: index === 0,
          acceptedAt: new Date(),
        },
      });
    }

    // A session and a class structure, so Phase 1 work has something to build on.
    const session = await tx.academicSession.create({
      data: {
        schoolId: school.id,
        name: '2025/2026',
        startDate: new Date('2025-09-15'),
        endDate: new Date('2026-07-24'),
        isCurrent: true,
      },
    });

    await tx.term.create({
      data: {
        schoolId: school.id,
        sessionId: session.id,
        name: 'FIRST',
        startDate: new Date('2025-09-15'),
        endDate: new Date('2025-12-12'),
        isCurrent: true,
      },
    });

    for (const [level, name] of [
      [1, 'JSS 1'],
      [2, 'JSS 2'],
      [3, 'JSS 3'],
    ] as const) {
      const klass = await tx.class.create({
        data: { schoolId: school.id, name, level },
      });
      await tx.classArm.createMany({
        data: [
          { schoolId: school.id, classId: klass.id, name: 'A', capacity: 40 },
          { schoolId: school.id, classId: klass.id, name: 'B', capacity: 40 },
        ],
      });
    }
  });

  console.log(`✓ ${input.name} seeded`);
}

/**
 * Refuses to touch anything but a database that is meant to be thrown away.
 *
 * This seed creates demo schools whose password is published in the README, so
 * the question is not "does this look like production" — that is a blocklist,
 * and the first real connection string proved it useless: a Neon URL reads
 * `…neon.tech/neondb`, which contains neither "prod" nor "live".
 *
 * So it is an allowlist instead. Seeding is permitted in exactly two places:
 * a database on this machine, or a deployment that says it is staging. Anything
 * else — a managed host from a laptop, a production deployment — is refused.
 *
 * NODE_ENV cannot be the discriminator, because staging deliberately runs with
 * NODE_ENV=production so that it behaves like production. APP_ENV is what names
 * the deployment.
 */
function assertSeedable(): void {
  if (process.env.ALLOW_SEED_IN_PRODUCTION === 'yes-i-mean-it') {
    console.warn('\n!! Seeding with the safety guard overridden.\n');
    return;
  }

  const raw = process.env.DATABASE_URL ?? '';
  let host = '';
  try {
    host = new URL(raw).hostname;
  } catch {
    throw new Error('Refusing to seed: DATABASE_URL is missing or malformed.');
  }

  // The Docker service name counts as local: that is how CI reaches Postgres.
  const LOCAL = ['localhost', '127.0.0.1', '::1', '0.0.0.0', 'postgres'];
  const isLocal = LOCAL.includes(host) || host.endsWith('.local');
  const isStaging = process.env.APP_ENV === 'staging';

  if (isLocal || isStaging) return;

  throw new Error(
    `Refusing to seed ${host}: it is neither a database on this machine nor a ` +
      'deployment that says APP_ENV=staging. This seed creates demo schools ' +
      'with a published password. If you are certain, set ' +
      'ALLOW_SEED_IN_PRODUCTION=yes-i-mean-it.',
  );
}

async function main(): Promise<void> {
  // The only guard. An earlier NODE_ENV===production check lived here and was
  // removed: staging sets NODE_ENV=production deliberately, so it blocked the
  // one deployment that is supposed to be seedable.
  assertSeedable();

  await syncPermissions();

  await seedSchool({
    name: 'Bright Star College',
    slug: 'bright-star-college',
    email: 'info@brightstar.test',
    city: 'Ibadan',
    state: 'Oyo',
    staff: [
      {
        email: 'proprietor@brightstar.test',
        firstName: 'Adebayo',
        lastName: 'Ogunleye',
        role: 'PROPRIETOR',
      },
      {
        email: 'principal@brightstar.test',
        firstName: 'Funmi',
        lastName: 'Adeyemi',
        role: 'PRINCIPAL',
      },
      {
        email: 'bursar@brightstar.test',
        firstName: 'Ifeanyi',
        lastName: 'Okafor',
        role: 'ACCOUNTANT',
      },
      {
        email: 'teacher@brightstar.test',
        firstName: 'Chioma',
        lastName: 'Nwosu',
        role: 'TEACHER',
      },
    ],
  });

  await seedSchool({
    name: 'Grace Height Academy',
    slug: 'grace-height-academy',
    email: 'info@graceheight.test',
    city: 'Abeokuta',
    state: 'Ogun',
    staff: [
      {
        email: 'proprietor@graceheight.test',
        firstName: 'Musa',
        lastName: 'Bello',
        role: 'PROPRIETOR',
      },
      {
        email: 'teacher@graceheight.test',
        firstName: 'Grace',
        lastName: 'Eze',
        role: 'TEACHER',
      },
    ],
  });

  console.log(`\nDemo accounts all use the password: ${DEMO_PASSWORD}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
