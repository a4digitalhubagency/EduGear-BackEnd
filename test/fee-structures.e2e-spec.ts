import {
  closeTestApp,
  createTestApp,
  registerSchool,
  RegisteredSchool,
  resetDatabase,
  TestContext,
} from './utils/test-app';

describe('Fee categories and structures', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let sessionId: string;
  let termId: string;
  let classId: string;
  let tuition: string;
  let books: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const auth = () => bearer(school.accessToken);

  const createCategory = (name: string) =>
    ctx.http().post('/api/finance/fee-categories').set(auth()).send({ name });

  const createStructure = (overrides: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post('/api/finance/fee-structures')
      .set(auth())
      .send({
        name: 'JSS1 First Term 2025/2026',
        sessionId,
        termId,
        classId,
        items: [{ categoryId: tuition, amount: 45000 }],
        ...overrides,
      });

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Finance College' });
    other = await registerSchool(ctx, { schoolName: 'Rival Academy' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.db.payment.deleteMany({});
    await ctx.db.studentFeeItem.deleteMany({});
    await ctx.db.studentFee.deleteMany({});
    await ctx.db.feeStructureItem.deleteMany({});
    await ctx.db.feeStructure.deleteMany({});
    await ctx.db.feeCategory.deleteMany({});
    await ctx.db.term.deleteMany({});
    await ctx.db.academicSession.deleteMany({});
    await ctx.db.class.deleteMany({});

    const session = await ctx
      .http()
      .post('/api/academics/sessions')
      .set(auth())
      .send({
        name: '2025/2026',
        startDate: '2025-09-15',
        endDate: '2026-07-24',
        isCurrent: true,
      })
      .expect(201);
    sessionId = session.body.id;

    const term = await ctx
      .http()
      .post('/api/academics/terms')
      .set(auth())
      .send({
        sessionId,
        name: 'FIRST',
        startDate: '2025-09-15',
        endDate: '2025-12-19',
        isCurrent: true,
      })
      .expect(201);
    termId = term.body.id;

    const klass = await ctx
      .http()
      .post('/api/academics/classes')
      .set(auth())
      .send({ name: 'JSS1', level: 1 })
      .expect(201);
    classId = klass.body.id;

    tuition = (await createCategory('Tuition').expect(201)).body.id;
    books = (await createCategory('Books').expect(201)).body.id;
  });

  // -------------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------------

  it('creates a fee category', async () => {
    const response = await createCategory('PTA Levy').expect(201);
    expect(response.body).toMatchObject({
      name: 'PTA Levy',
      isActive: true,
      usageCount: 0,
    });
  });

  it('rejects a duplicate category name', async () => {
    const response = await createCategory('tuition').expect(409);
    expect(response.body.errorCode).toBe('DUPLICATE_RESOURCE');
  });

  it('deletes an unused category', async () => {
    const category = await createCategory('Unused').expect(201);

    await ctx
      .http()
      .delete(`/api/finance/fee-categories/${category.body.id}`)
      .set(auth())
      .expect(204);
  });

  it('refuses to delete a category in use', async () => {
    await createStructure().expect(201);

    const response = await ctx
      .http()
      .delete(`/api/finance/fee-categories/${tuition}`)
      .set(auth())
      .expect(409);
    expect(response.body.message).toMatch(/Deactivate it instead/);
  });

  it('refuses to charge a retired category', async () => {
    await ctx
      .http()
      .patch(`/api/finance/fee-categories/${books}`)
      .set(auth())
      .send({ isActive: false })
      .expect(200);

    const response = await createStructure({
      items: [{ categoryId: books, amount: 5000 }],
    }).expect(409);
    expect(response.body.message).toMatch(/Retired fee categories/);
  });

  // -------------------------------------------------------------------------
  // Structures
  // -------------------------------------------------------------------------

  it('creates a structure and totals its items', async () => {
    const response = await createStructure({
      items: [
        { categoryId: tuition, amount: 45000 },
        { categoryId: books, amount: 7500.5 },
      ],
    }).expect(201);

    expect(response.body).toMatchObject({
      status: 'DRAFT',
      sessionName: '2025/2026',
      termName: 'FIRST',
      className: 'JSS1',
      totalAmount: 52500.5,
      invoiceCount: 0,
    });
    expect(response.body.items).toHaveLength(2);
  });

  it('leaves optional items out of the total', async () => {
    const response = await createStructure({
      items: [
        { categoryId: tuition, amount: 45000 },
        { categoryId: books, amount: 5000, isOptional: true },
      ],
    }).expect(201);

    // The bus place is quoted, not charged.
    expect(response.body.totalAmount).toBe(45000);
  });

  it('allows a session-wide structure with no term or class', async () => {
    const response = await createStructure({
      name: 'Session Development Levy',
      termId: null,
      classId: null,
    }).expect(201);
    expect(response.body.termId).toBeNull();
    expect(response.body.classId).toBeNull();
  });

  it('rejects a term from another session', async () => {
    const otherSession = await ctx
      .http()
      .post('/api/academics/sessions')
      .set(auth())
      .send({
        name: '2026/2027',
        startDate: '2026-07-25',
        endDate: '2027-07-24',
      })
      .expect(201);

    const response = await createStructure({
      sessionId: otherSession.body.id,
      name: 'Mismatched',
    }).expect(400);
    expect(response.body.message).toMatch(/does not belong to that session/);
  });

  it('rejects the same category twice in one structure', async () => {
    const response = await createStructure({
      items: [
        { categoryId: tuition, amount: 1000 },
        { categoryId: tuition, amount: 2000 },
      ],
    }).expect(400);
    expect(response.body.message).toMatch(/only appear once/);
  });

  it('rejects a duplicate structure name in one session', async () => {
    await createStructure().expect(201);
    await createStructure({ items: [{ categoryId: books, amount: 1 }] }).expect(
      409,
    );
  });

  it('rejects an empty item list', async () => {
    await createStructure({ items: [] }).expect(400);
  });

  it.each([-1, 100_000_001, 1.234])('rejects amount %p', async (amount) => {
    await createStructure({
      items: [{ categoryId: tuition, amount }],
    }).expect(400);
  });

  it('rejects an unknown category', async () => {
    await createStructure({
      items: [
        { categoryId: '11111111-1111-4111-8111-111111111111', amount: 100 },
      ],
    }).expect(404);
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  it('publishes a draft', async () => {
    const structure = await createStructure().expect(201);

    const response = await ctx
      .http()
      .post(`/api/finance/fee-structures/${structure.body.id}/publish`)
      .set(auth())
      .expect(200);
    expect(response.body.status).toBe('PUBLISHED');
  });

  it('refuses to publish twice', async () => {
    const structure = await createStructure().expect(201);
    await ctx
      .http()
      .post(`/api/finance/fee-structures/${structure.body.id}/publish`)
      .set(auth())
      .expect(200);

    await ctx
      .http()
      .post(`/api/finance/fee-structures/${structure.body.id}/publish`)
      .set(auth())
      .expect(409);
  });

  it('refuses to publish an archived structure', async () => {
    const structure = await createStructure().expect(201);
    await ctx
      .http()
      .post(`/api/finance/fee-structures/${structure.body.id}/archive`)
      .set(auth())
      .expect(200);

    await ctx
      .http()
      .post(`/api/finance/fee-structures/${structure.body.id}/publish`)
      .set(auth())
      .expect(409);
  });

  it('replaces the item list on update and re-totals', async () => {
    const structure = await createStructure().expect(201);

    const response = await ctx
      .http()
      .patch(`/api/finance/fee-structures/${structure.body.id}`)
      .set(auth())
      .send({ items: [{ categoryId: books, amount: 8000 }] })
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.totalAmount).toBe(8000);
  });

  it('refuses to change the scope of a structure', async () => {
    const structure = await createStructure().expect(201);

    // sessionId is not part of UpdateFeeStructureDto.
    await ctx
      .http()
      .patch(`/api/finance/fee-structures/${structure.body.id}`)
      .set(auth())
      .send({ sessionId })
      .expect(400);
  });

  it('deletes a structure with no invoices', async () => {
    const structure = await createStructure().expect(201);

    await ctx
      .http()
      .delete(`/api/finance/fee-structures/${structure.body.id}`)
      .set(auth())
      .expect(204);
  });

  it('filters by session, term and status', async () => {
    const draft = await createStructure().expect(201);
    await createStructure({ name: 'Second structure', termId: null }).expect(
      201,
    );
    await ctx
      .http()
      .post(`/api/finance/fee-structures/${draft.body.id}/publish`)
      .set(auth())
      .expect(200);

    const published = await ctx
      .http()
      .get('/api/finance/fee-structures?status=PUBLISHED')
      .set(auth())
      .expect(200);
    expect(published.body.data).toHaveLength(1);

    const byTerm = await ctx
      .http()
      .get(`/api/finance/fee-structures?termId=${termId}`)
      .set(auth())
      .expect(200);
    expect(byTerm.body.data).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  it('never shows another school its neighbour’s categories', async () => {
    const response = await ctx
      .http()
      .get('/api/finance/fee-categories')
      .set(bearer(other.accessToken))
      .expect(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('refuses to build a structure on another school’s session', async () => {
    await ctx
      .http()
      .post('/api/finance/fee-structures')
      .set(bearer(other.accessToken))
      .send({
        name: 'Trespass',
        sessionId,
        items: [{ categoryId: tuition, amount: 1000 }],
      })
      .expect(404);
  });

  it('lets two schools use the same category name', async () => {
    await ctx
      .http()
      .post('/api/finance/fee-categories')
      .set(bearer(other.accessToken))
      .send({ name: 'Tuition' })
      .expect(201);
  });
});
