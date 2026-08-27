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
 * Terms sit inside an academic session, and most of the rules here exist to
 * keep that containment honest.
 */
describe('Terms', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let teacherToken: string;
  let sessionId: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const auth = () => bearer(school.accessToken);

  const body = (overrides: Record<string, unknown> = {}) => ({
    sessionId,
    name: TermName.FIRST,
    startDate: '2025-09-15',
    endDate: '2025-12-19',
    ...overrides,
  });

  const createTerm = (overrides: Record<string, unknown> = {}) =>
    ctx.http().post('/api/academics/terms').set(auth()).send(body(overrides));

  /** Session runs 2025-09-15 → 2026-07-24, and starts out current. */
  async function freshSession(isCurrent = true): Promise<string> {
    const response = await ctx
      .http()
      .post('/api/academics/sessions')
      .set(auth())
      .send({
        name: '2025/2026',
        startDate: '2025-09-15',
        endDate: '2026-07-24',
        isCurrent,
      })
      .expect(201);
    return response.body.id;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Terms College' });
    other = await registerSchool(ctx, { schoolName: 'Rival Academy' });

    const role = await ctx.db.role.findFirstOrThrow({
      where: { schoolId: school.schoolId, slug: 'TEACHER' },
    });
    const user = await ctx.db.user.create({
      data: {
        email: 'teacher@terms.test',
        firstName: 'Ngozi',
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
      .send({ email: 'teacher@terms.test', password: 'StrongPass123' })
      .expect(200);
    teacherToken = login.body.tokens.accessToken;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.db.term.deleteMany({});
    await ctx.db.academicSession.deleteMany({});
    sessionId = await freshSession();
  });

  // -------------------------------------------------------------------------
  // Creation and containment
  // -------------------------------------------------------------------------

  it('creates a term', async () => {
    const response = await createTerm().expect(201);

    expect(response.body).toMatchObject({
      name: TermName.FIRST,
      sessionId,
      sessionName: '2025/2026',
      isCurrent: false,
    });
    expect(response.body.startDate).toBe('2025-09-15T00:00:00.000Z');
  });

  it('rejects a term starting before its session', async () => {
    const response = await createTerm({ startDate: '2025-09-01' }).expect(400);
    expect(response.body.message).toMatch(/within the session dates/i);
  });

  it('rejects a term ending after its session', async () => {
    await createTerm({
      name: TermName.THIRD,
      startDate: '2026-05-01',
      endDate: '2026-08-01',
    }).expect(400);
  });

  it('rejects an end date before the start date', async () => {
    await createTerm({
      startDate: '2025-12-19',
      endDate: '2025-09-15',
    }).expect(400);
  });

  it('rejects an unknown term name', async () => {
    await createTerm({ name: 'FOURTH' }).expect(400);
  });

  it('rejects an unknown session', async () => {
    await createTerm({
      sessionId: '11111111-1111-4111-8111-111111111111',
    }).expect(404);
  });

  it('rejects a second term with the same name in one session', async () => {
    await createTerm().expect(201);

    const response = await createTerm({
      startDate: '2026-01-06',
      endDate: '2026-04-10',
    }).expect(409);
    expect(response.body.errorCode).toBe('DUPLICATE_RESOURCE');
  });

  it('rejects terms that overlap within a session', async () => {
    await createTerm().expect(201);

    const response = await createTerm({
      name: TermName.SECOND,
      startDate: '2025-12-01',
      endDate: '2026-04-10',
    }).expect(409);
    expect(response.body.message).toMatch(/overlap/i);
  });

  it('accepts three consecutive terms filling a session', async () => {
    await createTerm().expect(201);
    await createTerm({
      name: TermName.SECOND,
      startDate: '2026-01-06',
      endDate: '2026-04-10',
    }).expect(201);
    await createTerm({
      name: TermName.THIRD,
      startDate: '2026-04-27',
      endDate: '2026-07-24',
    }).expect(201);

    const list = await ctx
      .http()
      .get(
        `/api/academics/terms?sessionId=${sessionId}&sortBy=name&sortOrder=asc`,
      )
      .set(auth())
      .expect(200);

    expect(list.body.data.map((t: { name: string }) => t.name)).toEqual([
      'FIRST',
      'SECOND',
      'THIRD',
    ]);
  });

  it('counts terms on the parent session', async () => {
    await createTerm().expect(201);

    const session = await ctx
      .http()
      .get(`/api/academics/sessions/${sessionId}`)
      .set(auth())
      .expect(200);
    expect(session.body.termCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The current term
  // -------------------------------------------------------------------------

  it('404s for the current term when none is set', async () => {
    await ctx
      .http()
      .get('/api/academics/terms/current')
      .set(auth())
      .expect(404);
  });

  it('creates a term already marked current', async () => {
    await createTerm({ isCurrent: true }).expect(201);

    const response = await ctx
      .http()
      .get('/api/academics/terms/current')
      .set(auth())
      .expect(200);
    expect(response.body.name).toBe(TermName.FIRST);
  });

  it('keeps exactly one term current', async () => {
    const first = await createTerm({ isCurrent: true }).expect(201);
    const second = await createTerm({
      name: TermName.SECOND,
      startDate: '2026-01-06',
      endDate: '2026-04-10',
    }).expect(201);

    await ctx
      .http()
      .post(`/api/academics/terms/${second.body.id}/set-current`)
      .set(auth())
      .expect(200);

    const list = await ctx
      .http()
      .get('/api/academics/terms?isCurrent=true')
      .set(auth())
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(second.body.id);

    const previous = await ctx
      .http()
      .get(`/api/academics/terms/${first.body.id}`)
      .set(auth())
      .expect(200);
    expect(previous.body.isCurrent).toBe(false);
  });

  it('refuses to make a term current while its session is not', async () => {
    // A second, non-current session, starting after the first one ends.
    const later = await ctx
      .http()
      .post('/api/academics/sessions')
      .set(auth())
      .send({
        name: '2026/2027',
        startDate: '2026-07-25',
        endDate: '2027-07-24',
      })
      .expect(201);

    const term = await createTerm({
      sessionId: later.body.id,
      startDate: '2026-09-14',
      endDate: '2026-12-18',
    }).expect(201);

    const response = await ctx
      .http()
      .post(`/api/academics/terms/${term.body.id}/set-current`)
      .set(auth())
      .expect(409);
    expect(response.body.message).toMatch(/session current first/i);
  });

  it('refuses to create a term as current when its session is not', async () => {
    const later = await ctx
      .http()
      .post('/api/academics/sessions')
      .set(auth())
      .send({
        name: '2026/2027',
        startDate: '2026-07-25',
        endDate: '2027-07-24',
      })
      .expect(201);

    await createTerm({
      sessionId: later.body.id,
      startDate: '2026-09-14',
      endDate: '2026-12-18',
      isCurrent: true,
    }).expect(409);
  });

  // -------------------------------------------------------------------------
  // Update and delete
  // -------------------------------------------------------------------------

  it('updates a term', async () => {
    const created = await createTerm().expect(201);

    const response = await ctx
      .http()
      .patch(`/api/academics/terms/${created.body.id}`)
      .set(auth())
      .send({ endDate: '2025-12-24' })
      .expect(200);
    expect(response.body.endDate).toBe('2025-12-24T00:00:00.000Z');
  });

  it('rejects an update that leaves the session range', async () => {
    const created = await createTerm().expect(201);

    await ctx
      .http()
      .patch(`/api/academics/terms/${created.body.id}`)
      .set(auth())
      .send({ endDate: '2026-08-30' })
      .expect(400);
  });

  it('refuses to move a term to another session', async () => {
    const created = await createTerm().expect(201);

    // sessionId is not part of UpdateTermDto, so forbidNonWhitelisted rejects it.
    await ctx
      .http()
      .patch(`/api/academics/terms/${created.body.id}`)
      .set(auth())
      .send({ sessionId })
      .expect(400);
  });

  it('deletes a term', async () => {
    const created = await createTerm().expect(201);

    await ctx
      .http()
      .delete(`/api/academics/terms/${created.body.id}`)
      .set(auth())
      .expect(204);

    await ctx
      .http()
      .get(`/api/academics/terms/${created.body.id}`)
      .set(auth())
      .expect(404);
  });

  it('refuses to delete the current term', async () => {
    const created = await createTerm({ isCurrent: true }).expect(201);

    const response = await ctx
      .http()
      .delete(`/api/academics/terms/${created.body.id}`)
      .set(auth())
      .expect(409);
    expect(response.body.message).toMatch(/current term cannot be deleted/i);
  });

  it('blocks deleting a session while it still has terms', async () => {
    await createTerm().expect(201);

    // The session refuses while terms exist, so this is the supported order.
    await ctx
      .http()
      .delete(`/api/academics/sessions/${sessionId}`)
      .set(auth())
      .expect(409);
  });

  // -------------------------------------------------------------------------
  // Authorization and tenant isolation
  // -------------------------------------------------------------------------

  it('lets a teacher read but not create', async () => {
    await createTerm().expect(201);

    await ctx
      .http()
      .get('/api/academics/terms')
      .set(bearer(teacherToken))
      .expect(200);

    const denied = await ctx
      .http()
      .post('/api/academics/terms')
      .set(bearer(teacherToken))
      .send(body({ name: TermName.SECOND }))
      .expect(403);
    expect(denied.body.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('never shows another school its neighbour’s terms', async () => {
    await createTerm().expect(201);

    const response = await ctx
      .http()
      .get('/api/academics/terms')
      .set(bearer(other.accessToken))
      .expect(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('refuses to hang a term off another school’s session', async () => {
    // The session id is real, but it belongs to a different tenant.
    await ctx
      .http()
      .post('/api/academics/terms')
      .set(bearer(other.accessToken))
      .send(body())
      .expect(404);
  });

  it('404s when another school requests a term by id', async () => {
    const created = await createTerm().expect(201);

    await ctx
      .http()
      .get(`/api/academics/terms/${created.body.id}`)
      .set(bearer(other.accessToken))
      .expect(404);
  });

  it('records an audit entry on creation', async () => {
    const created = await createTerm().expect(201);

    const entry = await ctx.db.auditLog.findFirst({
      where: {
        schoolId: school.schoolId,
        action: 'term.created',
        entityId: created.body.id,
      },
    });
    expect(entry).not.toBeNull();
  });
});
