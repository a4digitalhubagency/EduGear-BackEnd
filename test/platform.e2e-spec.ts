import { PlatformRole, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import {
  closeTestApp,
  createTestApp,
  registerSchool,
  RegisteredSchool,
  resetDatabase,
  TestContext,
} from './utils/test-app';

const PASSWORD = 'PlatformPass123';

/**
 * A4's operator console.
 *
 * This is the only surface that reads across tenants, so the property that
 * matters most is that the two scopes cannot cross: a school token must never
 * reach a platform route, and a platform token must never reach a school one.
 * Everything else here is secondary to that.
 */
describe('Platform console', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Creates a platform account at the given role and signs it in. */
  async function platformLogin(
    email: string,
    role: PlatformRole,
  ): Promise<string> {
    const user = await ctx.db.user.upsert({
      where: { email },
      update: {},
      create: {
        email,
        firstName: 'A4',
        lastName: 'Operator',
        passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
      },
    });
    await ctx.db.platformAdmin.upsert({
      where: { userId: user.id },
      update: { role, disabledAt: null },
      create: { userId: user.id, role },
    });

    const login = await ctx
      .http()
      .post('/api/platform/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return login.body.tokens.accessToken;
  }

  const schoolRow = (id: string) =>
    ctx.db.school.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Platform College' });
    other = await registerSchool(ctx, { schoolName: 'Rival Academy' });
  });

  // -------------------------------------------------------------------------
  // The boundary between the two scopes
  // -------------------------------------------------------------------------

  it('refuses a school token on a platform route, without confirming it exists', async () => {
    // A proprietor holds every permission their school has. None of them is this.
    const response = await ctx
      .http()
      .get('/api/platform/schools')
      .set(bearer(school.accessToken));

    // 404, not 403: a school's token should not be able to confirm that the
    // operator console is even there.
    expect(response.status).toBe(404);
  });

  it('refuses a platform token on a school route', async () => {
    const token = await platformLogin('ops@a4.test', PlatformRole.OWNER);

    for (const path of [
      '/api/students',
      '/api/finance/invoices',
      '/api/schools/me/settings',
      '/api/audit-logs',
    ]) {
      const response = await ctx.http().get(path).set(bearer(token));
      expect(response.status).toBe(403);
    }
  });

  it('refuses an unauthenticated caller', async () => {
    await ctx.http().get('/api/platform/schools').expect(401);
    await ctx.http().get('/api/platform/stats').expect(401);
  });

  it('will not sign in a school user at the platform door', async () => {
    const response = await ctx
      .http()
      .post('/api/platform/auth/login')
      .send({ email: school.email, password: school.password })
      .expect(401);

    // The same message a wrong password gives: this endpoint cannot be used to
    // discover who has an operator account.
    expect(response.body.message).toMatch(/invalid email or password/i);
  });

  it('will not sign in an operator whose access was revoked', async () => {
    const token = await platformLogin('revoked@a4.test', PlatformRole.OWNER);
    await ctx.http().get('/api/platform/me').set(bearer(token)).expect(200);

    await ctx.db.platformAdmin.updateMany({
      where: { user: { email: 'revoked@a4.test' } },
      data: { disabledAt: new Date() },
    });

    // Read on every request rather than cached, so revocation bites at once.
    await ctx.http().get('/api/platform/me').set(bearer(token)).expect(403);
    await ctx
      .http()
      .post('/api/platform/auth/login')
      .send({ email: 'revoked@a4.test', password: PASSWORD })
      .expect(401);
  });

  // -------------------------------------------------------------------------
  // Roles within the console
  // -------------------------------------------------------------------------

  it('lets SUPPORT look but not touch', async () => {
    const token = await platformLogin('support@a4.test', PlatformRole.SUPPORT);

    await ctx
      .http()
      .get('/api/platform/schools')
      .set(bearer(token))
      .expect(200);

    await ctx
      .http()
      .post(`/api/platform/schools/${school.schoolId}/suspend`)
      .set(bearer(token))
      .send({ reason: 'trying it on' })
      .expect(403);

    // Managing other operators is the owner's alone.
    await ctx.http().get('/api/platform/admins').set(bearer(token)).expect(403);
  });

  it('lets OPERATOR change status but not grant access', async () => {
    const token = await platformLogin('ops2@a4.test', PlatformRole.OPERATOR);

    await ctx
      .http()
      .post(`/api/platform/schools/${school.schoolId}/suspend`)
      .set(bearer(token))
      .send({ reason: 'unpaid' })
      .expect(200);

    await ctx
      .http()
      .post('/api/platform/admins')
      .set(bearer(token))
      .send({ email: 'someone@a4.test', role: 'SUPPORT' })
      .expect(403);
  });

  // -------------------------------------------------------------------------
  // Suspension
  // -------------------------------------------------------------------------

  it('stops every login at a suspended school, at once', async () => {
    const token = await platformLogin('ops@a4.test', PlatformRole.OWNER);

    // Warm the permission cache, so this proves invalidation and not just a
    // cold read.
    await ctx
      .http()
      .get('/api/students')
      .set(bearer(school.accessToken))
      .expect(200);

    await ctx
      .http()
      .post(`/api/platform/schools/${school.schoolId}/suspend`)
      .set(bearer(token))
      .send({ reason: 'Subscription unpaid since September' })
      .expect(200);

    // Without cache invalidation this would keep working for up to 30 seconds.
    await ctx
      .http()
      .get('/api/students')
      .set(bearer(school.accessToken))
      .expect(403);

    // And they cannot simply sign in again.
    await ctx
      .http()
      .post('/api/auth/login')
      .send({ email: school.email, password: school.password })
      .expect(403);

    // The other school is untouched.
    await ctx
      .http()
      .get('/api/students')
      .set(bearer(other.accessToken))
      .expect(200);
  });

  it('records a suspension on the school’s own audit trail', async () => {
    const token = await platformLogin('ops@a4.test', PlatformRole.OWNER);

    await ctx
      .http()
      .post(`/api/platform/schools/${school.schoolId}/suspend`)
      .set(bearer(token))
      .send({ reason: 'Subscription unpaid since September' })
      .expect(200);

    const entry = await ctx.db.auditLog.findFirstOrThrow({
      where: { action: 'platform.school_suspended' },
    });
    // Against the school, so its own trail explains what happened to it.
    expect(entry.schoolId).toBe(school.schoolId);
    expect(entry.description).toContain('Subscription unpaid');
    expect(entry.membershipId).toBeNull();
  });

  it('reactivates a suspended school', async () => {
    const token = await platformLogin('ops@a4.test', PlatformRole.OWNER);

    await ctx
      .http()
      .post(`/api/platform/schools/${school.schoolId}/suspend`)
      .set(bearer(token))
      .send({ reason: 'unpaid' })
      .expect(200);
    await ctx
      .http()
      .post(`/api/platform/schools/${school.schoolId}/reactivate`)
      .set(bearer(token))
      .expect(200);

    await ctx
      .http()
      .get('/api/students')
      .set(bearer(school.accessToken))
      .expect(200);
  });

  it('refuses to suspend a school twice', async () => {
    const token = await platformLogin('ops@a4.test', PlatformRole.OWNER);
    const suspend = () =>
      ctx
        .http()
        .post(`/api/platform/schools/${school.schoolId}/suspend`)
        .set(bearer(token))
        .send({ reason: 'unpaid' });

    await suspend().expect(200);
    await suspend().expect(409);
  });

  it('cancels as a soft delete, keeping every record', async () => {
    const token = await platformLogin('ops@a4.test', PlatformRole.OWNER);

    const before = await ctx.db.student.count({
      where: { schoolId: school.schoolId },
    });

    await ctx
      .http()
      .post(`/api/platform/schools/${school.schoolId}/cancel`)
      .set(bearer(token))
      .send({ reason: 'Left for a competitor' })
      .expect(200);

    const row = await schoolRow(school.schoolId);
    expect(row.status).toBe('CANCELLED');
    expect(row.deletedAt).not.toBeNull();
    // Nothing destroyed: a school that comes back expects its records.
    expect(
      await ctx.db.student.count({ where: { schoolId: school.schoolId } }),
    ).toBe(before);

    // Reactivating is the undo, and clears the soft-delete marker.
    await ctx
      .http()
      .post(`/api/platform/schools/${school.schoolId}/reactivate`)
      .set(bearer(token))
      .expect(200);
    expect((await schoolRow(school.schoolId)).deletedAt).toBeNull();
  });

  it('404s for a school that does not exist', async () => {
    const token = await platformLogin('ops@a4.test', PlatformRole.OWNER);
    await ctx
      .http()
      .get('/api/platform/schools/2b4e7c5a-0000-4000-8000-000000000000')
      .set(bearer(token))
      .expect(404);
  });

  // -------------------------------------------------------------------------
  // What the console shows — metadata only
  // -------------------------------------------------------------------------

  it('lists schools with usage, and no tenant data', async () => {
    const token = await platformLogin('ops@a4.test', PlatformRole.OWNER);

    const response = await ctx
      .http()
      .get('/api/platform/schools')
      .set(bearer(token))
      .expect(200);

    expect(response.body.meta.total).toBe(2);
    const row = response.body.data.find(
      (r: { id: string }) => r.id === school.schoolId,
    );
    expect(row).toMatchObject({
      name: 'Platform College',
      status: 'ACTIVE',
      studentCount: 0,
      staffCount: 1,
      ownerEmail: school.email,
    });

    // The line this surface must not cross: no names, no money, no results.
    const serialised = JSON.stringify(response.body);
    for (const leak of ['students', 'invoices', 'payments', 'results']) {
      expect(serialised).not.toContain(`"${leak}"`);
    }
  });

  it('searches and filters by status', async () => {
    const token = await platformLogin('ops@a4.test', PlatformRole.OWNER);

    const found = await ctx
      .http()
      .get('/api/platform/schools?search=Rival')
      .set(bearer(token))
      .expect(200);
    expect(found.body.data).toHaveLength(1);
    expect(found.body.data[0].name).toBe('Rival Academy');

    await ctx
      .http()
      .post(`/api/platform/schools/${school.schoolId}/suspend`)
      .set(bearer(token))
      .send({ reason: 'unpaid' })
      .expect(200);

    const suspended = await ctx
      .http()
      .get('/api/platform/schools?status=SUSPENDED')
      .set(bearer(token))
      .expect(200);
    expect(suspended.body.data).toHaveLength(1);
    expect(suspended.body.data[0].id).toBe(school.schoolId);
  });

  it('counts across every school', async () => {
    const token = await platformLogin('ops@a4.test', PlatformRole.OWNER);

    const response = await ctx
      .http()
      .get('/api/platform/stats')
      .set(bearer(token))
      .expect(200);

    expect(response.body).toMatchObject({
      totalSchools: 2,
      activeSchools: 2,
      suspendedSchools: 0,
      totalStaff: 2,
      newSchoolsLast30Days: 2,
    });
  });

  // -------------------------------------------------------------------------
  // Who may operate the platform
  // -------------------------------------------------------------------------

  it('will not grant platform access to someone who belongs to a school', async () => {
    const token = await platformLogin('ops@a4.test', PlatformRole.OWNER);

    // The whole separation argument: if this were allowed, one phished
    // proprietor would be every school's problem.
    const response = await ctx
      .http()
      .post('/api/platform/admins')
      .set(bearer(token))
      .send({ email: school.email, role: 'SUPPORT' })
      .expect(409);

    expect(response.body.message).toMatch(/belongs to a school/i);
  });

  it('will not let a school invite a platform account', async () => {
    await platformLogin('ops@a4.test', PlatformRole.OWNER);

    const role = await ctx.db.role.findFirstOrThrow({
      where: { schoolId: school.schoolId, slug: 'TEACHER' },
    });

    const response = await ctx
      .http()
      .post('/api/users/invite')
      .set(bearer(school.accessToken))
      .send({
        email: 'ops@a4.test',
        firstName: 'A4',
        lastName: 'Operator',
        roleId: role.id,
      })
      .expect(409);

    expect(response.body.message).toMatch(/platform account/i);
  });

  it('grants access to a user with no school, and lists them', async () => {
    const token = await platformLogin('ops@a4.test', PlatformRole.OWNER);

    await ctx.db.user.create({
      data: {
        email: 'newops@a4.test',
        firstName: 'New',
        lastName: 'Operator',
        passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
      },
    });

    const granted = await ctx
      .http()
      .post('/api/platform/admins')
      .set(bearer(token))
      .send({ email: 'newops@a4.test', role: 'SUPPORT' })
      .expect(201);
    expect(granted.body).toMatchObject({
      email: 'newops@a4.test',
      role: 'SUPPORT',
    });

    const list = await ctx
      .http()
      .get('/api/platform/admins')
      .set(bearer(token))
      .expect(200);
    expect(list.body).toHaveLength(2);
  });

  it('refuses to grant access to a user who does not exist', async () => {
    const token = await platformLogin('ops@a4.test', PlatformRole.OWNER);
    await ctx
      .http()
      .post('/api/platform/admins')
      .set(bearer(token))
      .send({ email: 'nobody@a4.test', role: 'SUPPORT' })
      .expect(404);
  });

  it('will not let an operator revoke their own access', async () => {
    const token = await platformLogin('ops@a4.test', PlatformRole.OWNER);
    const me = await ctx
      .http()
      .get('/api/platform/me')
      .set(bearer(token))
      .expect(200);

    await ctx
      .http()
      .delete(`/api/platform/admins/${me.body.id}`)
      .set(bearer(token))
      .expect(409);
  });

  it('always leaves A4 with at least one owner', async () => {
    const owner = await platformLogin('ops@a4.test', PlatformRole.OWNER);
    const second = await platformLogin('ops2@a4.test', PlatformRole.OWNER);

    const idOf = (token: string) =>
      ctx
        .http()
        .get('/api/platform/me')
        .set(bearer(token))
        .expect(200)
        .then((r) => r.body.id as string);

    // One owner may remove another.
    await ctx
      .http()
      .delete(`/api/platform/admins/${await idOf(second)}`)
      .set(bearer(owner))
      .expect(204);

    // But never themselves — which is what makes lockout impossible, because the
    // last owner standing is by definition the one making the request.
    await ctx
      .http()
      .delete(`/api/platform/admins/${await idOf(owner)}`)
      .set(bearer(owner))
      .expect(409);

    expect(
      await ctx.db.platformAdmin.count({
        where: { role: PlatformRole.OWNER, disabledAt: null },
      }),
    ).toBe(1);
  });

  it('kills an operator’s session the moment their access is revoked', async () => {
    const owner = await platformLogin('ops@a4.test', PlatformRole.OWNER);
    const support = await platformLogin(
      'support@a4.test',
      PlatformRole.SUPPORT,
    );

    const supportId = (
      await ctx.http().get('/api/platform/me').set(bearer(support)).expect(200)
    ).body.id;

    await ctx
      .http()
      .delete(`/api/platform/admins/${supportId}`)
      .set(bearer(owner))
      .expect(204);

    await ctx.http().get('/api/platform/me').set(bearer(support)).expect(403);
  });
});
