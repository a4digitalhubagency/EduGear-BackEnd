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
const HOUR = 60 * 60 * 1000;

/**
 * The breach register that section 40(8) of the NDP Act requires.
 *
 * Two properties matter more than the CRUD: the 72-hour clock in s.40(2) is
 * measured from discovery and reported honestly, and the register cannot be
 * emptied — a record you can delete proves nothing to a regulator.
 */
describe('Breach register', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let operatorToken: string;
  let supportToken: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const hoursAgo = (hours: number) =>
    new Date(Date.now() - hours * HOUR).toISOString();

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

  const validBreach = (overrides: Record<string, unknown> = {}) => ({
    discoveredAt: hoursAgo(2),
    description:
      'A misconfigured export endpoint returned guardian phone numbers to an ' +
      'authenticated user of another school for roughly forty minutes.',
    dataCategories: ['Guardian names', 'Guardian phone numbers'],
    riskAssessment:
      'Contact details only; no financial or health data. Limited audience, ' +
      'and the recipient reported it themselves.',
    contactName: 'A4 Operator',
    contactEmail: 'privacy@edugear.ng',
    ...overrides,
  });

  const record = (overrides: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post('/api/platform/breaches')
      .set(bearer(operatorToken))
      .send(validBreach(overrides));

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Breach Test College' });
    operatorToken = await platformLogin('ops@a4.test', PlatformRole.OPERATOR);
    supportToken = await platformLogin('support@a4.test', PlatformRole.SUPPORT);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.db.breachRecord.deleteMany({});
  });

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  it('records a breach and allocates a reference', async () => {
    const response = await record().expect(201);

    expect(response.body.reference).toMatch(/^BR-\d{4}-\d{4}$/);
    expect(response.body.status).toBe('OPEN');
    expect(response.body.dataCategories).toEqual([
      'Guardian names',
      'Guardian phone numbers',
    ]);
  });

  it('numbers references sequentially within the year', async () => {
    const first = await record().expect(201);
    const second = await record().expect(201);

    const year = new Date().getUTCFullYear();
    expect(first.body.reference).toBe(`BR-${year}-0001`);
    expect(second.body.reference).toBe(`BR-${year}-0002`);
  });

  it('records which schools were affected', async () => {
    const response = await record({
      affectedSchoolIds: [school.schoolId],
      affectedSubjects: 42,
    }).expect(201);

    expect(response.body.affectedSchoolIds).toEqual([school.schoolId]);
    expect(response.body.affectedSubjects).toBe(42);
  });

  it('refuses a description that does not describe anything', async () => {
    // A regulator reads this field. "Oops" is not a record of the facts.
    await record({ description: 'Oops' }).expect(400);
  });

  it('refuses an entry with no data categories', async () => {
    await record({ dataCategories: [] }).expect(400);
  });

  it('rejects unknown fields', async () => {
    await record({ coverUp: true }).expect(400);
  });

  // -------------------------------------------------------------------------
  // The 72-hour clock — s.40(2)
  // -------------------------------------------------------------------------

  describe('the section 40(2) clock', () => {
    it('runs from discovery, not from when the breach began', async () => {
      // Discovered 2 hours ago but running since August: still 70 hours left.
      const response = await record({
        discoveredAt: hoursAgo(2),
        occurredFrom: new Date('2026-08-01T00:00:00.000Z').toISOString(),
      }).expect(201);

      expect(response.body.notificationState).toBe('DUE');
      expect(response.body.hoursUntilDeadline).toBe(69);
    });

    it('reports a fresh breach as DUE and not yet needing attention', async () => {
      const response = await record({ discoveredAt: hoursAgo(1) }).expect(201);

      expect(response.body.notificationState).toBe('DUE');
      expect(response.body.needsAttention).toBe(false);
    });

    it('flags one approaching the deadline', async () => {
      const response = await record({ discoveredAt: hoursAgo(60) }).expect(201);

      expect(response.body.notificationState).toBe('DUE');
      expect(response.body.needsAttention).toBe(true);
    });

    it('reports an unnotified breach past 72 hours as OVERDUE', async () => {
      const response = await record({ discoveredAt: hoursAgo(80) }).expect(201);

      expect(response.body.notificationState).toBe('OVERDUE');
      expect(response.body.needsAttention).toBe(true);
      expect(response.body.hoursUntilDeadline).toBeLessThan(0);
    });

    it('reports ON_TIME once notified inside the window', async () => {
      const created = await record({ discoveredAt: hoursAgo(10) }).expect(201);

      const updated = await ctx
        .http()
        .patch(`/api/platform/breaches/${created.body.id}`)
        .set(bearer(operatorToken))
        .send({ commissionNotifiedAt: hoursAgo(1) })
        .expect(200);

      expect(updated.body.notificationState).toBe('ON_TIME');
      expect(updated.body.needsAttention).toBe(false);
    });

    it('says LATE rather than quietly accepting a missed deadline', async () => {
      // The register has to be willing to record our own failure. If a late
      // notification read as ON_TIME, the register would be worse than useless.
      const created = await record({ discoveredAt: hoursAgo(100) }).expect(201);

      const updated = await ctx
        .http()
        .patch(`/api/platform/breaches/${created.body.id}`)
        .set(bearer(operatorToken))
        .send({ commissionNotifiedAt: hoursAgo(1) })
        .expect(200);

      expect(updated.body.notificationState).toBe('LATE');
    });

    it('accepts a reasoned decision that notification is not required', async () => {
      const created = await record({ discoveredAt: hoursAgo(90) }).expect(201);
      expect(created.body.notificationState).toBe('OVERDUE');

      const updated = await ctx
        .http()
        .patch(`/api/platform/breaches/${created.body.id}`)
        .set(bearer(operatorToken))
        .send({
          notificationNotRequiredReason:
            'Data was encrypted at rest and the key was never exposed; no ' +
            'risk to the rights and freedoms of any individual.',
        })
        .expect(200);

      expect(updated.body.notificationState).toBe('NOT_REQUIRED');
      expect(updated.body.needsAttention).toBe(false);
    });

    it('will not accept a one-word excuse as an assessment', async () => {
      const created = await record({ discoveredAt: hoursAgo(90) }).expect(201);

      await ctx
        .http()
        .patch(`/api/platform/breaches/${created.body.id}`)
        .set(bearer(operatorToken))
        .send({ notificationNotRequiredReason: 'No' })
        .expect(400);

      const unchanged = await ctx
        .http()
        .get(`/api/platform/breaches/${created.body.id}`)
        .set(bearer(operatorToken))
        .expect(200);
      expect(unchanged.body.notificationState).toBe('OVERDUE');
    });
  });

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  describe('listing', () => {
    it('returns the most recently discovered first', async () => {
      await record({ discoveredAt: hoursAgo(80) }).expect(201);
      const recent = await record({ discoveredAt: hoursAgo(1) }).expect(201);

      const list = await ctx
        .http()
        .get('/api/platform/breaches')
        .set(bearer(supportToken))
        .expect(200);

      expect(list.body.data[0].id).toBe(recent.body.id);
    });

    it('narrows to those needing attention, and counts only those', async () => {
      // The count and the page have to agree, or "3 need attention" shows one.
      await record({ discoveredAt: hoursAgo(1) }).expect(201);
      await record({ discoveredAt: hoursAgo(2) }).expect(201);
      const overdue = await record({ discoveredAt: hoursAgo(90) }).expect(201);

      const list = await ctx
        .http()
        .get('/api/platform/breaches?needsAttention=true')
        .set(bearer(supportToken))
        .expect(200);

      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].id).toBe(overdue.body.id);
      expect(list.body.meta.total).toBe(1);
    });

    it('excludes a breach that has been dealt with', async () => {
      const created = await record({ discoveredAt: hoursAgo(90) }).expect(201);
      await ctx
        .http()
        .patch(`/api/platform/breaches/${created.body.id}`)
        .set(bearer(operatorToken))
        .send({ commissionNotifiedAt: hoursAgo(1) })
        .expect(200);

      const list = await ctx
        .http()
        .get('/api/platform/breaches?needsAttention=true')
        .set(bearer(supportToken))
        .expect(200);

      expect(list.body.data).toHaveLength(0);
      expect(list.body.meta.total).toBe(0);
    });

    it('filters by status', async () => {
      const a = await record().expect(201);
      await record().expect(201);
      await ctx
        .http()
        .patch(`/api/platform/breaches/${a.body.id}`)
        .set(bearer(operatorToken))
        .send({ status: 'CLOSED' })
        .expect(200);

      const list = await ctx
        .http()
        .get('/api/platform/breaches?status=CLOSED')
        .set(bearer(supportToken))
        .expect(200);

      expect(list.body.data).toHaveLength(1);
      expect(list.body.meta.total).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // The register cannot be emptied
  // -------------------------------------------------------------------------

  it('offers no way to delete an entry', async () => {
    const created = await record().expect(201);

    await ctx
      .http()
      .delete(`/api/platform/breaches/${created.body.id}`)
      .set(bearer(operatorToken))
      .expect(404);

    expect(
      await ctx.db.breachRecord.count({ where: { id: created.body.id } }),
    ).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  it('audits the recording and, separately, the Commission notification', async () => {
    const created = await record().expect(201);
    await ctx
      .http()
      .patch(`/api/platform/breaches/${created.body.id}`)
      .set(bearer(operatorToken))
      .send({ commissionNotifiedAt: hoursAgo(1) })
      .expect(200);

    const actions = await ctx.db.auditLog.findMany({
      where: { entityType: 'BreachRecord', entityId: created.body.id },
      select: { action: true },
    });
    const names = actions.map((a) => a.action);

    expect(names).toContain('platform.breach_recorded');
    // Separate from the generic update: this is the fact the register exists
    // to be able to prove.
    expect(names).toContain('platform.breach_commission_notified');
  });

  it('does not copy the breach narrative into the audit metadata', async () => {
    // The description can hold incident detail. Duplicating it into a second
    // table doubles the exposure for no gain.
    const created = await record().expect(201);
    await ctx
      .http()
      .patch(`/api/platform/breaches/${created.body.id}`)
      .set(bearer(operatorToken))
      .send({ containment: 'Endpoint disabled and the export cache purged.' })
      .expect(200);

    const entry = await ctx.db.auditLog.findFirstOrThrow({
      where: { entityId: created.body.id, action: 'platform.breach_updated' },
    });
    expect(JSON.stringify(entry.metadata)).not.toContain('cache purged');
    expect(entry.metadata).toMatchObject({ fields: ['containment'] });
  });

  // -------------------------------------------------------------------------
  // Scope and permission boundaries
  // -------------------------------------------------------------------------

  describe('access', () => {
    it('lets SUPPORT read but not write', async () => {
      const created = await record().expect(201);

      await ctx
        .http()
        .get('/api/platform/breaches')
        .set(bearer(supportToken))
        .expect(200);

      await ctx
        .http()
        .post('/api/platform/breaches')
        .set(bearer(supportToken))
        .send(validBreach())
        .expect(403);

      await ctx
        .http()
        .patch(`/api/platform/breaches/${created.body.id}`)
        .set(bearer(supportToken))
        .send({ status: 'CLOSED' })
        .expect(403);
    });

    it('gives a school token 404, never a 403', async () => {
      // A school may not even confirm that this surface exists.
      await ctx
        .http()
        .get('/api/platform/breaches')
        .set(bearer(school.accessToken))
        .expect(404);

      await ctx
        .http()
        .post('/api/platform/breaches')
        .set(bearer(school.accessToken))
        .send(validBreach())
        .expect(404);
    });

    it('refuses an unauthenticated request', async () => {
      await ctx.http().get('/api/platform/breaches').expect(401);
      await ctx
        .http()
        .post('/api/platform/breaches')
        .send(validBreach())
        .expect(401);
    });

    it('404s for an entry that does not exist', async () => {
      await ctx
        .http()
        .get('/api/platform/breaches/11111111-1111-4111-8111-111111111111')
        .set(bearer(supportToken))
        .expect(404);
    });
  });
});
