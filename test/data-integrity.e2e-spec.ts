import {
  closeTestApp,
  createTestApp,
  registerSchool,
  RegisteredSchool,
  resetDatabase,
  TestContext,
} from './utils/test-app';

/**
 * Deletes that would silently destroy financial history must be refused.
 *
 * Several relations cascade at the database level (student → invoices and
 * payments; session / term / class → fee structures). A cascade is the right
 * default for tidy-up, and the wrong one for money: these tests pin the
 * application-level refusals that stand in front of them.
 */
describe('Data integrity across modules', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let sessionId: string;
  let termId: string;
  let classId: string;
  let armId: string;
  let studentId: string;
  let categoryId: string;

  const auth = () => ({ Authorization: `Bearer ${school.accessToken}` });

  async function structure(overrides: Record<string, unknown> = {}) {
    const created = await ctx
      .http()
      .post('/api/finance/fee-structures')
      .set(auth())
      .send({
        name: `Structure ${Math.random().toString(36).slice(2, 7)}`,
        sessionId,
        items: [{ categoryId, amount: 10000 }],
        ...overrides,
      })
      .expect(201);
    await ctx
      .http()
      .post(`/api/finance/fee-structures/${created.body.id}/publish`)
      .set(auth())
      .expect(200);
    return created.body.id as string;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Integrity College' });
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
    await ctx.db.student.deleteMany({});
    await ctx.db.classArm.deleteMany({});
    await ctx.db.class.deleteMany({});
    await ctx.db.term.deleteMany({});
    await ctx.db.academicSession.deleteMany({});

    sessionId = (
      await ctx
        .http()
        .post('/api/academics/sessions')
        .set(auth())
        .send({
          name: '2025/2026',
          startDate: '2025-09-15',
          endDate: '2026-07-24',
        })
        .expect(201)
    ).body.id;

    termId = (
      await ctx
        .http()
        .post('/api/academics/terms')
        .set(auth())
        .send({
          sessionId,
          name: 'FIRST',
          startDate: '2025-09-15',
          endDate: '2025-12-19',
        })
        .expect(201)
    ).body.id;

    classId = (
      await ctx
        .http()
        .post('/api/academics/classes')
        .set(auth())
        .send({ name: 'JSS1', level: 1 })
        .expect(201)
    ).body.id;

    armId = (
      await ctx
        .http()
        .post('/api/academics/class-arms')
        .set(auth())
        .send({ classId, name: 'A' })
        .expect(201)
    ).body.id;

    studentId = (
      await ctx
        .http()
        .post('/api/students')
        .set(auth())
        .send({
          firstName: 'Ada',
          lastName: 'Obi',
          gender: 'FEMALE',
          admissionDate: '2025-09-15',
          classArmId: armId,
        })
        .expect(201)
    ).body.id;

    categoryId = (
      await ctx
        .http()
        .post('/api/finance/fee-categories')
        .set(auth())
        .send({ name: 'Tuition' })
        .expect(201)
    ).body.id;
  });

  it('refuses to delete a student who has been invoiced', async () => {
    const structureId = await structure();
    await ctx
      .http()
      .post('/api/finance/invoices/assign')
      .set(auth())
      .send({ structureId, studentIds: [studentId] })
      .expect(201);

    const response = await ctx
      .http()
      .delete(`/api/students/${studentId}`)
      .set(auth())
      .expect(409);
    expect(response.body.message).toMatch(/financial records/i);

    // The invoice survived.
    expect(await ctx.db.studentFee.count()).toBe(1);
  });

  it('still deletes a student with no financial history', async () => {
    await ctx
      .http()
      .delete(`/api/students/${studentId}`)
      .set(auth())
      .expect(204);
  });

  it('refuses to delete a term that fee structures are built on', async () => {
    await structure({ termId });

    const response = await ctx
      .http()
      .delete(`/api/academics/terms/${termId}`)
      .set(auth())
      .expect(409);
    expect(response.body.message).toMatch(/fee structure/i);
    expect(await ctx.db.feeStructure.count()).toBe(1);
  });

  it('refuses to delete a session that fee structures are built on', async () => {
    // Remove the term first so the fee structure is the only thing in the way.
    await ctx
      .http()
      .delete(`/api/academics/terms/${termId}`)
      .set(auth())
      .expect(204);
    await structure();

    const response = await ctx
      .http()
      .delete(`/api/academics/sessions/${sessionId}`)
      .set(auth())
      .expect(409);
    expect(response.body.message).toMatch(/fee structure/i);
  });

  it('refuses to delete a class that fee structures are built on', async () => {
    await ctx
      .http()
      .delete(`/api/academics/class-arms/${armId}`)
      .set(auth())
      .expect(409); // still has a student
    await ctx.db.student.deleteMany({});
    await ctx
      .http()
      .delete(`/api/academics/class-arms/${armId}`)
      .set(auth())
      .expect(204);

    await structure({ classId });

    const response = await ctx
      .http()
      .delete(`/api/academics/classes/${classId}`)
      .set(auth())
      .expect(409);
    expect(response.body.message).toMatch(/fee structure/i);
  });
});
