import { MembershipStatus, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import {
  closeTestApp,
  createTestApp,
  registerSchool,
  RegisteredSchool,
  resetDatabase,
  TestContext,
} from './utils/test-app';

/**
 * Permission-based authorization: what a role may do is decided server-side,
 * per permission, on every request.
 */
describe('Authorization (RBAC)', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let teacherToken: string;
  let accountantToken: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function createStaffAndLogin(
    roleSlug: string,
    email: string,
  ): Promise<string> {
    const role = await ctx.db.role.findFirstOrThrow({
      where: { schoolId: school.schoolId, slug: roleSlug },
    });

    const user = await ctx.db.user.create({
      data: {
        email,
        firstName: 'Staff',
        lastName: roleSlug,
        passwordHash: await argon2.hash('StrongPass123', {
          type: argon2.argon2id,
        }),
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
      },
    });

    await ctx.db.membership.create({
      data: {
        userId: user.id,
        schoolId: school.schoolId,
        roleId: role.id,
        status: MembershipStatus.ACTIVE,
        acceptedAt: new Date(),
      },
    });

    const response = await ctx
      .http()
      .post('/api/auth/login')
      .send({ email, password: 'StrongPass123' })
      .expect(200);

    return response.body.tokens.accessToken;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'RBAC High School' });
    teacherToken = await createStaffAndLogin('TEACHER', 'teacher@rbac.test');
    accountantToken = await createStaffAndLogin(
      'ACCOUNTANT',
      'accountant@rbac.test',
    );
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('grants the proprietor every school permission', async () => {
    const response = await ctx
      .http()
      .get('/api/auth/me')
      .set(bearer(school.accessToken))
      .expect(200);

    expect(response.body.permissions).toEqual(
      expect.arrayContaining([
        'users.create',
        'finance.verify',
        'results.publish',
        'audit.read',
      ]),
    );
  });

  it('lets a teacher read the school profile (school.read)', async () => {
    await ctx
      .http()
      .get('/api/schools/me')
      .set(bearer(teacherToken))
      .expect(200);
  });

  it('blocks a teacher from listing staff (users.read)', async () => {
    const response = await ctx
      .http()
      .get('/api/users')
      .set(bearer(teacherToken))
      .expect(403);

    expect(response.body.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
    expect(response.body.message).toContain('users.read');
  });

  it('blocks a teacher from inviting staff (users.create)', async () => {
    await ctx
      .http()
      .post('/api/users/invite')
      .set(bearer(teacherToken))
      .send({
        email: 'someone@rbac.test',
        firstName: 'Some',
        lastName: 'One',
        roleId: school.membershipId,
      })
      .expect(403);
  });

  it('blocks an accountant from reading the audit trail (audit.read)', async () => {
    await ctx
      .http()
      .get('/api/audit-logs')
      .set(bearer(accountantToken))
      .expect(403);
  });

  it('allows the proprietor to read the audit trail', async () => {
    await ctx
      .http()
      .get('/api/audit-logs')
      .set(bearer(school.accessToken))
      .expect(200);
  });

  it('reflects a role change on the next request', async () => {
    const teacher = await ctx.db.user.findFirstOrThrow({
      where: { email: 'teacher@rbac.test' },
    });
    const membership = await ctx.db.membership.findFirstOrThrow({
      where: { userId: teacher.id, schoolId: school.schoolId },
    });

    await ctx
      .http()
      .patch(`/api/users/${membership.id}`)
      .set(bearer(school.accessToken))
      .send({
        roleId: (
          await ctx.db.role.findFirstOrThrow({
            where: { schoolId: school.schoolId, slug: 'ADMINISTRATOR' },
          })
        ).id,
      })
      .expect(200);

    // Promotion takes effect immediately: the update invalidates the cached snapshot.
    await ctx.http().get('/api/users').set(bearer(teacherToken)).expect(200);
  });

  it('refuses to suspend the school’s only proprietor', async () => {
    const response = await ctx
      .http()
      .patch(`/api/users/${school.membershipId}`)
      .set(bearer(school.accessToken))
      .send({ status: 'SUSPENDED' })
      .expect(409);

    expect(response.body.message).toContain('at least one active proprietor');
  });

  it('rejects unknown fields instead of silently ignoring them', async () => {
    const response = await ctx
      .http()
      .patch('/api/schools/me')
      .set(bearer(school.accessToken))
      .send({ name: 'Renamed School', status: 'ACTIVE', isSuperAdmin: true })
      .expect(400);

    expect(response.body.errorCode).toBe('VALIDATION_ERROR');
  });
});
