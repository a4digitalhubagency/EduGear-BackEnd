import { MembershipStatus, TermName, UserStatus } from '@prisma/client';
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
 * Academic sessions — the first Phase 1 feature, and the root of the academic
 * structure that terms, classes and students hang off.
 */
describe('Academic sessions', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let teacherToken: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const auth = () => bearer(school.accessToken);

  const body = (overrides: Record<string, unknown> = {}) => ({
    name: '2025/2026',
    startDate: '2025-09-15',
    endDate: '2026-07-24',
    ...overrides,
  });

  const createSession = (overrides: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post('/api/academics/sessions')
      .set(auth())
      .send(body(overrides));

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Sessions College' });
    other = await registerSchool(ctx, { schoolName: 'Other Academy' });

    const role = await ctx.db.role.findFirstOrThrow({
      where: { schoolId: school.schoolId, slug: 'TEACHER' },
    });
    const user = await ctx.db.user.create({
      data: {
        email: 'teacher@sessions.test',
        firstName: 'Tayo',
        lastName: 'Teacher',
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
    const login = await ctx
      .http()
      .post('/api/auth/login')
      .send({ email: 'teacher@sessions.test', password: 'StrongPass123' })
      .expect(200);
    teacherToken = login.body.tokens.accessToken;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  // Each test starts from a clean slate of sessions, so ordering is irrelevant.
  beforeEach(async () => {
    await ctx.db.term.deleteMany({});
    await ctx.db.academicSession.deleteMany({});
  });

  // -------------------------------------------------------------------------
  // Creation and validation
  // -------------------------------------------------------------------------

  it('creates a session', async () => {
    const response = await createSession().expect(201);

    expect(response.body).toMatchObject({
      name: '2025/2026',
      isCurrent: false,
      termCount: 0,
    });
    expect(response.body.startDate).toBe('2025-09-15T00:00:00.000Z');
    expect(response.body.id).toEqual(expect.any(String));
  });

  it('rejects a name that is not two consecutive years', async () => {
    const response = await createSession({ name: '2025/2027' }).expect(400);
    expect(response.body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('rejects an end date before the start date', async () => {
    await createSession({
      startDate: '2026-07-24',
      endDate: '2025-09-15',
    }).expect(400);
  });

  it('rejects an unknown field', async () => {
    await createSession({ schoolId: other.schoolId }).expect(400);
  });

  it('rejects a duplicate name', async () => {
    await createSession().expect(201);

    const response = await createSession({
      startDate: '2027-09-15',
      endDate: '2028-07-24',
    }).expect(409);
    expect(response.body.errorCode).toBe('DUPLICATE_RESOURCE');
  });

  it('rejects dates overlapping an existing session', async () => {
    await createSession().expect(201);

    const response = await createSession({
      name: '2026/2027',
      startDate: '2026-07-01',
      endDate: '2027-07-24',
    }).expect(409);
    expect(response.body.message).toMatch(/overlap/i);
  });

  it('allows a session starting the day after the previous one ends', async () => {
    await createSession().expect(201);

    await createSession({
      name: '2026/2027',
      startDate: '2026-07-25',
      endDate: '2027-07-24',
    }).expect(201);
  });

  // -------------------------------------------------------------------------
  // The current session
  // -------------------------------------------------------------------------

  it('404s for the current session when none is set', async () => {
    await ctx
      .http()
      .get('/api/academics/sessions/current')
      .set(auth())
      .expect(404);
  });

  it('creates a session already marked current', async () => {
    await createSession({ isCurrent: true }).expect(201);

    const response = await ctx
      .http()
      .get('/api/academics/sessions/current')
      .set(auth())
      .expect(200);
    expect(response.body.name).toBe('2025/2026');
  });

  it('keeps exactly one session current', async () => {
    const first = await createSession({ isCurrent: true }).expect(201);
    const second = await createSession({
      name: '2026/2027',
      startDate: '2026-07-25',
      endDate: '2027-07-24',
    }).expect(201);

    await ctx
      .http()
      .post(`/api/academics/sessions/${second.body.id}/set-current`)
      .set(auth())
      .expect(200);

    const list = await ctx
      .http()
      .get('/api/academics/sessions?isCurrent=true')
      .set(auth())
      .expect(200);

    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(second.body.id);

    const previous = await ctx
      .http()
      .get(`/api/academics/sessions/${first.body.id}`)
      .set(auth())
      .expect(200);
    expect(previous.body.isCurrent).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Listing, update, delete
  // -------------------------------------------------------------------------

  it('paginates and sorts the list', async () => {
    await createSession().expect(201);
    await createSession({
      name: '2026/2027',
      startDate: '2026-07-25',
      endDate: '2027-07-24',
    }).expect(201);

    const response = await ctx
      .http()
      .get(
        '/api/academics/sessions?limit=1&page=1&sortBy=startDate&sortOrder=asc',
      )
      .set(auth())
      .expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].name).toBe('2025/2026');
    expect(response.body.meta).toMatchObject({ total: 2, hasNextPage: true });
  });

  it('updates a session', async () => {
    const created = await createSession().expect(201);

    const response = await ctx
      .http()
      .patch(`/api/academics/sessions/${created.body.id}`)
      .set(auth())
      .send({ endDate: '2026-08-01' })
      .expect(200);

    expect(response.body.endDate).toBe('2026-08-01T00:00:00.000Z');
    expect(response.body.name).toBe('2025/2026');
  });

  it('deletes a session', async () => {
    const created = await createSession().expect(201);

    await ctx
      .http()
      .delete(`/api/academics/sessions/${created.body.id}`)
      .set(auth())
      .expect(204);

    await ctx
      .http()
      .get(`/api/academics/sessions/${created.body.id}`)
      .set(auth())
      .expect(404);
  });

  it('refuses to delete the current session', async () => {
    const created = await createSession({ isCurrent: true }).expect(201);

    const response = await ctx
      .http()
      .delete(`/api/academics/sessions/${created.body.id}`)
      .set(auth())
      .expect(409);
    expect(response.body.message).toMatch(/current session cannot be deleted/i);
  });

  it('refuses to delete a session that still has terms', async () => {
    const created = await createSession().expect(201);
    await ctx.db.term.create({
      data: {
        schoolId: school.schoolId,
        sessionId: created.body.id,
        name: TermName.FIRST,
        startDate: new Date('2025-09-15'),
        endDate: new Date('2025-12-19'),
      },
    });

    const response = await ctx
      .http()
      .delete(`/api/academics/sessions/${created.body.id}`)
      .set(auth())
      .expect(409);
    expect(response.body.message).toMatch(/term/i);
  });

  it('reports the term count', async () => {
    const created = await createSession().expect(201);
    await ctx.db.term.create({
      data: {
        schoolId: school.schoolId,
        sessionId: created.body.id,
        name: TermName.FIRST,
        startDate: new Date('2025-09-15'),
        endDate: new Date('2025-12-19'),
      },
    });

    const response = await ctx
      .http()
      .get(`/api/academics/sessions/${created.body.id}`)
      .set(auth())
      .expect(200);
    expect(response.body.termCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Authorization and tenant isolation
  // -------------------------------------------------------------------------

  it('lets a teacher read but not create', async () => {
    await createSession().expect(201);

    await ctx
      .http()
      .get('/api/academics/sessions')
      .set(bearer(teacherToken))
      .expect(200);

    const denied = await ctx
      .http()
      .post('/api/academics/sessions')
      .set(bearer(teacherToken))
      .send(body({ name: '2026/2027' }))
      .expect(403);
    expect(denied.body.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('never shows another school its neighbour’s sessions', async () => {
    await createSession().expect(201);

    const response = await ctx
      .http()
      .get('/api/academics/sessions')
      .set(bearer(other.accessToken))
      .expect(200);

    expect(response.body.data).toHaveLength(0);
  });

  it('404s when another school requests a session by id', async () => {
    const created = await createSession().expect(201);

    await ctx
      .http()
      .get(`/api/academics/sessions/${created.body.id}`)
      .set(bearer(other.accessToken))
      .expect(404);
  });

  it('refuses to let another school delete a session', async () => {
    const created = await createSession().expect(201);

    await ctx
      .http()
      .delete(`/api/academics/sessions/${created.body.id}`)
      .set(bearer(other.accessToken))
      .expect(404);

    const survivor = await ctx.db.academicSession.findUnique({
      where: { id: created.body.id },
    });
    expect(survivor).not.toBeNull();
  });

  it('lets two schools hold the same session name independently', async () => {
    await createSession().expect(201);

    await ctx
      .http()
      .post('/api/academics/sessions')
      .set(bearer(other.accessToken))
      .send(body())
      .expect(201);
  });

  it('records an audit entry on creation', async () => {
    const created = await createSession().expect(201);

    const entry = await ctx.db.auditLog.findFirst({
      where: {
        schoolId: school.schoolId,
        action: 'academic_session.created',
        entityId: created.body.id,
      },
    });
    expect(entry).not.toBeNull();
  });
});
