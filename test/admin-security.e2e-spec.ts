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

interface Staff {
  token: string;
  membershipId: string;
  userId: string;
  email: string;
}

/**
 * Privilege escalation, from the attacker's side.
 *
 * Every test here is an attempt by a legitimately-logged-in member of staff to
 * end up holding a permission nobody gave them. The rule they all run into is
 * the same: you cannot grant — to yourself or anyone else — a permission you do
 * not hold, and you cannot change your own role at all.
 */
describe('Administration security', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let principal: Staff;
  let administrator: Staff;
  let teacher: Staff;
  /** Can manage roles and staff, but holds no finance powers. */
  let deputy!: Staff;
  let deputyRoleId!: string;
  let roles: Record<string, string>;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const proprietor = () => bearer(school.accessToken);

  async function staffMember(slug: string, email: string): Promise<Staff> {
    const role = await ctx.db.role.findFirstOrThrow({
      where: { schoolId: school.schoolId, slug },
    });
    const user = await ctx.db.user.create({
      data: {
        email,
        firstName: slug,
        lastName: 'Member',
        passwordHash: await argon2.hash('StrongPass123', {
          type: argon2.argon2id,
        }),
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
      },
    });
    const membership = await ctx.db.membership.create({
      data: {
        userId: user.id,
        schoolId: school.schoolId,
        roleId: role.id,
        status: MembershipStatus.ACTIVE,
        acceptedAt: new Date(),
      },
    });
    const login = await ctx
      .http()
      .post('/api/auth/login')
      .send({ email, password: 'StrongPass123' })
      .expect(200);
    return {
      token: login.body.tokens.accessToken,
      membershipId: membership.id,
      userId: user.id,
      email,
    };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Security College' });

    principal = await staffMember('PRINCIPAL', 'principal@security.test');
    administrator = await staffMember('ADMINISTRATOR', 'admin@security.test');
    teacher = await staffMember('TEACHER', 'teacher@security.test');

    const rows = await ctx.db.role.findMany({
      where: { schoolId: school.schoolId },
    });
    roles = Object.fromEntries(rows.map((role) => [role.slug, role.id]));

    // Someone who can manage roles and staff but holds no finance powers, so
    // the no-escalation rule is what these tests hit, not the permission guard.
    const deputyRole = await ctx
      .http()
      .post('/api/schools/me/roles')
      .set(proprietor())
      .send({
        name: 'Deputy Head',
        permissions: [
          'roles.read',
          'roles.update',
          'users.read',
          'users.update',
          'finance.read',
        ],
      })
      .expect(201);
    deputyRoleId = deputyRole.body.id;

    deputy = await staffMember('TEACHER', 'deputy@security.test');
    await ctx.db.membership.update({
      where: { id: deputy.membershipId },
      data: { roleId: deputyRoleId },
    });
    const relogin = await ctx
      .http()
      .post('/api/auth/login')
      .send({ email: deputy.email, password: 'StrongPass123' })
      .expect(200);
    deputy.token = relogin.body.tokens.accessToken;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  /** What a token can actually do right now, straight from the server. */
  async function permissionsOf(token: string): Promise<string[]> {
    const me = await ctx
      .http()
      .get('/api/auth/me')
      .set(bearer(token))
      .expect(200);
    return me.body.permissions ?? me.body.activeSchool?.permissions ?? [];
  }

  describe('role assignment', () => {
    it('refuses a principal promoting themselves to proprietor', async () => {
      const response = await ctx
        .http()
        .patch(`/api/users/${principal.membershipId}`)
        .set(bearer(principal.token))
        .send({ roleId: roles.PROPRIETOR })
        .expect(403);
      expect(response.body.message).toMatch(/own role/i);

      expect(await permissionsOf(principal.token)).not.toContain(
        'finance.verify',
      );
    });

    it('refuses an administrator handing the proprietor role to someone else', async () => {
      const response = await ctx
        .http()
        .patch(`/api/users/${teacher.membershipId}`)
        .set(bearer(administrator.token))
        .send({ roleId: roles.PROPRIETOR })
        .expect(403);
      expect(response.body.message).toMatch(/cannot grant/i);

      expect(await permissionsOf(teacher.token)).not.toContain(
        'finance.verify',
      );
    });

    it('refuses inviting a new proprietor from an account that is not one', async () => {
      await ctx
        .http()
        .post('/api/users/invite')
        .set(bearer(principal.token))
        .send({
          email: 'newboss@security.test',
          firstName: 'New',
          lastName: 'Boss',
          roleId: roles.PROPRIETOR,
        })
        .expect(403);
    });

    it('still lets a principal assign a role within their own powers', async () => {
      await ctx
        .http()
        .patch(`/api/users/${teacher.membershipId}`)
        .set(bearer(principal.token))
        .send({ roleId: roles.ADMINISTRATOR })
        .expect(200);
      // Put it back.
      await ctx
        .http()
        .patch(`/api/users/${teacher.membershipId}`)
        .set(proprietor())
        .send({ roleId: roles.TEACHER })
        .expect(200);
    });

    it('lets the proprietor promote someone, since they hold everything', async () => {
      await ctx
        .http()
        .patch(`/api/users/${administrator.membershipId}`)
        .set(proprietor())
        .send({ roleId: roles.PROPRIETOR })
        .expect(200);
      await ctx
        .http()
        .patch(`/api/users/${administrator.membershipId}`)
        .set(proprietor())
        .send({ roleId: roles.ADMINISTRATOR })
        .expect(200);
    });
  });

  describe('role management', () => {
    afterEach(async () => {
      // Custom roles only; the standard six are left alone.
      // Everything the tests created — but not the deputy's own role, which
      // their membership still points at.
      await ctx.db.rolePermission.deleteMany({
        where: { role: { isSystem: false }, roleId: { not: deputyRoleId } },
      });
      await ctx.db.role.deleteMany({
        where: {
          schoolId: school.schoolId,
          isSystem: false,
          id: { not: deputyRoleId },
        },
      });
    });

    const createRole = (token: string, body: Record<string, unknown>) =>
      ctx.http().post('/api/schools/me/roles').set(bearer(token)).send(body);

    it('creates a role from permissions the caller holds', async () => {
      const response = await createRole(school.accessToken, {
        name: 'Exams Officer',
        description: 'Runs the exam timetable and results',
        permissions: ['results.read', 'results.update', 'academics.read'],
      }).expect(201);

      expect(response.body).toMatchObject({
        name: 'Exams Officer',
        isSystem: false,
        memberCount: 0,
      });
      expect(response.body.permissions).toEqual([
        'academics.read',
        'results.read',
        'results.update',
      ]);
    });

    it('refuses a role carrying a permission the caller lacks', async () => {
      // The deputy can manage roles but holds no finance.verify, so they
      // cannot mint it — this is the rule, not the permission guard.
      const response = await createRole(deputy.token, {
        name: 'Shadow Bursar',
        permissions: ['finance.read', 'finance.verify'],
      }).expect(403);
      expect(response.body.message).toMatch(
        /Verify or reject payment evidence/,
      );
      expect(
        await ctx.db.role.count({ where: { name: 'Shadow Bursar' } }),
      ).toBe(0);
    });

    it('refuses parent portal access on a staff role', async () => {
      const response = await createRole(school.accessToken, {
        name: 'Pretend Parent',
        permissions: ['portal.access'],
      }).expect(400);
      expect(response.body.message).toMatch(/linking a parent record/);
    });

    it('refuses an unknown permission', async () => {
      const response = await createRole(school.accessToken, {
        name: 'Typo Role',
        permissions: ['finance.raed'],
      }).expect(400);
      expect(response.body.message).toMatch(
        /Unknown permission\(s\): finance.raed/,
      );
    });

    it('copies an existing role, subject to the same rule', async () => {
      const copy = await createRole(school.accessToken, {
        name: 'Deputy Principal',
        copyFromRoleId: roles.PRINCIPAL,
      }).expect(201);
      expect(copy.body.permissions).toContain('users.update');

      // The deputy cannot clone the proprietor.
      await createRole(deputy.token, {
        name: 'Deputy Proprietor',
        copyFromRoleId: roles.PROPRIETOR,
      }).expect(403);
    });

    it('keeps names unique and never reuses a standard slug', async () => {
      await createRole(school.accessToken, {
        name: 'Exams Officer',
        permissions: [],
      }).expect(201);
      await createRole(school.accessToken, {
        name: 'exams officer',
        permissions: [],
      }).expect(409);

      // "Teacher" itself is refused by name. This is a new name whose slug
      // would land on the standard TEACHER role's, so it gets a suffix.
      const reserved = await createRole(school.accessToken, {
        name: 'Teacher!',
        permissions: [],
      }).expect(201);
      expect(reserved.body.slug).toBe('TEACHER_CUSTOM');

      const distinct = await createRole(school.accessToken, {
        name: 'Teacher (Part Time)',
        permissions: [],
      }).expect(201);
      expect(distinct.body.slug).toBe('TEACHER_PART_TIME');
    });

    it('protects the standard roles from renaming and deletion', async () => {
      await ctx
        .http()
        .patch(`/api/schools/me/roles/${roles.TEACHER}`)
        .set(proprietor())
        .send({ name: 'Tutor' })
        .expect(409);
      await ctx
        .http()
        .delete(`/api/schools/me/roles/${roles.TEACHER}`)
        .set(proprietor())
        .expect(409);
    });

    it('keeps the proprietor role all-powerful, as the way back in', async () => {
      const response = await ctx
        .http()
        .put(`/api/schools/me/roles/${roles.PROPRIETOR}/permissions`)
        .set(proprietor())
        .send({ permissions: ['school.read'] })
        .expect(409);
      expect(response.body.message).toMatch(/recovers/);
    });

    it('applies a permission change to everyone holding the role at once', async () => {
      expect(await permissionsOf(teacher.token)).not.toContain('finance.read');

      await ctx
        .http()
        .put(`/api/schools/me/roles/${roles.TEACHER}/permissions`)
        .set(proprietor())
        .send({ permissions: ['students.read', 'finance.read'] })
        .expect(200);

      // Immediately, not after the 30-second cache window.
      expect(await permissionsOf(teacher.token)).toContain('finance.read');
      await ctx
        .http()
        .get('/api/finance/invoices')
        .set(bearer(teacher.token))
        .expect(200);

      await ctx
        .http()
        .put(`/api/schools/me/roles/${roles.TEACHER}/permissions`)
        .set(proprietor())
        .send({ permissions: ['students.read'] })
        .expect(200);
      await ctx
        .http()
        .get('/api/finance/invoices')
        .set(bearer(teacher.token))
        .expect(403);
    });

    it('records what a permission change added and removed', async () => {
      await ctx
        .http()
        .put(`/api/schools/me/roles/${roles.TEACHER}/permissions`)
        .set(proprietor())
        .send({ permissions: ['students.read', 'reports.read'] })
        .expect(200);

      const entry = await ctx.db.auditLog.findFirst({
        where: {
          schoolId: school.schoolId,
          action: 'role.permissions.updated',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(entry?.metadata).toMatchObject({ added: ['reports.read'] });
    });

    it('refuses widening a role beyond the caller’s own powers', async () => {
      await ctx
        .http()
        .put(`/api/schools/me/roles/${roles.TEACHER}/permissions`)
        .set(bearer(deputy.token))
        .send({ permissions: ['students.read', 'finance.verify'] })
        .expect(403);
    });

    it('empties a role before deleting it, and never moves your own membership', async () => {
      const role = await createRole(school.accessToken, {
        name: 'Exams Officer',
        permissions: ['results.read'],
      }).expect(201);

      await ctx
        .http()
        .patch(`/api/users/${teacher.membershipId}`)
        .set(proprietor())
        .send({ roleId: role.body.id })
        .expect(200);

      const inUse = await ctx
        .http()
        .delete(`/api/schools/me/roles/${role.body.id}`)
        .set(proprietor())
        .expect(409);
      expect(inUse.body.message).toMatch(/held by 1 member/);

      const moved = await ctx
        .http()
        .post(`/api/schools/me/roles/${role.body.id}/reassign-members`)
        .set(proprietor())
        .send({ toRoleId: roles.TEACHER })
        .expect(200);
      expect(moved.body.moved).toBe(1);

      await ctx
        .http()
        .delete(`/api/schools/me/roles/${role.body.id}`)
        .set(proprietor())
        .expect(204);
    });

    it('refuses to move your own membership between roles', async () => {
      const response = await ctx
        .http()
        .post(`/api/schools/me/roles/${deputyRoleId}/reassign-members`)
        .set(bearer(deputy.token))
        .send({ toRoleId: roles.TEACHER })
        .expect(403);
      expect(response.body.message).toMatch(/your own membership/);
    });

    it('never shows or changes another school’s roles', async () => {
      const rival = await registerSchool(ctx, { schoolName: 'Rival Academy' });
      await ctx
        .http()
        .get(`/api/schools/me/roles/${roles.TEACHER}`)
        .set(bearer(rival.accessToken))
        .expect(404);
      await ctx
        .http()
        .put(`/api/schools/me/roles/${roles.TEACHER}/permissions`)
        .set(bearer(rival.accessToken))
        .send({ permissions: ['students.read'] })
        .expect(404);
    });
  });
});
