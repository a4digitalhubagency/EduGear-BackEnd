import {
  closeTestApp,
  createTestApp,
  registerSchool,
  RegisteredSchool,
  resetDatabase,
  TestContext,
} from './utils/test-app';

describe('Finance reports', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let sessionId: string;
  let armId: string;
  let structureId: string;
  let students: { id: string; studentId: string }[];

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const auth = () => bearer(school.accessToken);

  const summary = async (qs = '') =>
    (
      await ctx
        .http()
        .get(`/api/finance/reports/summary${qs}`)
        .set(auth())
        .expect(200)
    ).body;

  const debtors = async (qs = '') =>
    (
      await ctx
        .http()
        .get(`/api/finance/reports/debtors${qs}`)
        .set(auth())
        .expect(200)
    ).body;

  /** Bills the whole arm 50,000 each. */
  async function billEveryone(): Promise<string[]> {
    const result = await ctx
      .http()
      .post('/api/finance/invoices/assign')
      .set(auth())
      .send({ structureId, classArmId: armId })
      .expect(201);
    return result.body.invoices.map((i: { id: string }) => i.id);
  }

  async function payAndVerify(invoiceId: string, amount: number) {
    const payment = await ctx
      .http()
      .post('/api/finance/payments')
      .set(auth())
      .send({
        studentFeeId: invoiceId,
        amount,
        method: 'CASH',
        paidAt: '2025-10-01T10:00:00Z',
      })
      .expect(201);

    await ctx
      .http()
      .post(`/api/finance/payments/${payment.body.id}/verify`)
      .set(auth())
      .expect(200);

    return payment.body.id;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Reports College' });
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
    await ctx.db.studentGuardian.deleteMany({});
    await ctx.db.guardian.deleteMany({});
    await ctx.db.student.deleteMany({});
    await ctx.db.classArm.deleteMany({});
    await ctx.db.class.deleteMany({});
    await ctx.db.academicSession.deleteMany({});

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

    const klass = await ctx
      .http()
      .post('/api/academics/classes')
      .set(auth())
      .send({ name: 'JSS1', level: 1 })
      .expect(201);
    const arm = await ctx
      .http()
      .post('/api/academics/class-arms')
      .set(auth())
      .send({ classId: klass.body.id, name: 'A' })
      .expect(201);
    armId = arm.body.id;

    const imported = await ctx
      .http()
      .post('/api/students/bulk')
      .set(auth())
      .send({
        students: [
          {
            firstName: 'Ada',
            lastName: 'Obi',
            gender: 'FEMALE',
            admissionDate: '2025-09-15',
            classArmId: armId,
          },
          {
            firstName: 'Bola',
            lastName: 'Ade',
            gender: 'MALE',
            admissionDate: '2025-09-15',
            classArmId: armId,
          },
        ],
      })
      .expect(201);
    students = imported.body.students;

    const tuition = await ctx
      .http()
      .post('/api/finance/fee-categories')
      .set(auth())
      .send({ name: 'Tuition' })
      .expect(201);

    const structure = await ctx
      .http()
      .post('/api/finance/fee-structures')
      .set(auth())
      .send({
        name: 'JSS1 First Term',
        sessionId,
        dueDate: '2025-10-15',
        items: [{ categoryId: tuition.body.id, amount: 50000 }],
      })
      .expect(201);
    structureId = structure.body.id;

    await ctx
      .http()
      .post(`/api/finance/fee-structures/${structureId}/publish`)
      .set(auth())
      .expect(200);
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  it('is empty before anything is billed', async () => {
    expect(await summary()).toMatchObject({
      invoiceCount: 0,
      totalBilled: 0,
      totalOutstanding: 0,
      collectionRate: 100,
    });
  });

  it('reports what was billed and what is owed', async () => {
    await billEveryone();

    expect(await summary()).toMatchObject({
      invoiceCount: 2,
      studentCount: 2,
      totalBilled: 100000,
      totalPayable: 100000,
      totalCollected: 0,
      totalOutstanding: 100000,
      collectionRate: 0,
      debtorCount: 2,
    });
  });

  it('counts only verified money as collected', async () => {
    const [first] = await billEveryone();

    await ctx
      .http()
      .post('/api/finance/payments')
      .set(auth())
      .send({
        studentFeeId: first,
        amount: 20000,
        method: 'CASH',
        paidAt: '2025-10-01T10:00:00Z',
      })
      .expect(201);

    // Recorded but unverified: it shows as pending, not as collected.
    const pending = await summary();
    expect(pending).toMatchObject({
      totalCollected: 0,
      totalOutstanding: 100000,
      pendingVerification: 20000,
    });

    await payAndVerify(first, 30000);
    expect(await summary()).toMatchObject({
      totalCollected: 30000,
      totalOutstanding: 70000,
      collectionRate: 30,
    });
  });

  it('breaks collections down by method', async () => {
    const [first, second] = await billEveryone();
    await payAndVerify(first, 10000);
    await payAndVerify(second, 5000);

    const report = await summary();
    expect(report.byMethod).toEqual([
      { method: 'CASH', count: 2, total: 15000 },
    ]);
  });

  it('excludes discounted amounts from what is payable', async () => {
    const [first] = await billEveryone();
    await ctx
      .http()
      .post(`/api/finance/invoices/${first}/discount`)
      .set(auth())
      .send({ amount: 20000, reason: 'Sibling discount' })
      .expect(200);

    expect(await summary()).toMatchObject({
      totalBilled: 100000,
      totalDiscounted: 20000,
      totalPayable: 80000,
      totalOutstanding: 80000,
    });
  });

  it('does not count a waived invoice as a debt', async () => {
    const [first] = await billEveryone();
    await ctx
      .http()
      .post(`/api/finance/invoices/${first}/waive`)
      .set(auth())
      .send({ reason: 'Staff child' })
      .expect(200);

    expect(await summary()).toMatchObject({
      totalOutstanding: 50000,
      debtorCount: 1,
    });
  });

  it('leaves a cancelled invoice out of the report entirely', async () => {
    const [first] = await billEveryone();
    await ctx
      .http()
      .post(`/api/finance/invoices/${first}/cancel`)
      .set(auth())
      .send({ reason: 'Raised in error' })
      .expect(200);

    expect(await summary()).toMatchObject({
      invoiceCount: 1,
      totalBilled: 50000,
    });
  });

  it('filters by class arm', async () => {
    await billEveryone();

    const scoped = await summary(`?classArmId=${armId}`);
    expect(scoped.invoiceCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Debtors
  // -------------------------------------------------------------------------

  it('lists debtors largest first', async () => {
    const [first, second] = await billEveryone();
    await payAndVerify(first, 40000);
    await payAndVerify(second, 10000);

    const list = await debtors();
    expect(list.data).toHaveLength(2);
    expect(list.data[0].totalOwed).toBe(40000);
    expect(list.data[1].totalOwed).toBe(10000);
  });

  it('aggregates several invoices per student', async () => {
    await billEveryone();

    const extra = await ctx
      .http()
      .post('/api/finance/fee-categories')
      .set(auth())
      .send({ name: 'Excursion' })
      .expect(201);
    const second = await ctx
      .http()
      .post('/api/finance/fee-structures')
      .set(auth())
      .send({
        name: 'Excursion levy',
        sessionId,
        items: [{ categoryId: extra.body.id, amount: 5000 }],
      })
      .expect(201);
    await ctx
      .http()
      .post(`/api/finance/fee-structures/${second.body.id}/publish`)
      .set(auth())
      .expect(200);
    await ctx
      .http()
      .post('/api/finance/invoices/assign')
      .set(auth())
      .send({ structureId: second.body.id, studentIds: [students[0].id] })
      .expect(201);

    const list = await debtors();
    const top = list.data[0];
    expect(top.totalOwed).toBe(55000);
    expect(top.invoiceCount).toBe(2);
  });

  it('drops a student once they have paid in full', async () => {
    const [first] = await billEveryone();
    await payAndVerify(first, 50000);

    const list = await debtors();
    expect(list.data).toHaveLength(1);
  });

  it('filters by minimum balance', async () => {
    const [first] = await billEveryone();
    await payAndVerify(first, 49000);

    const list = await debtors('?minBalance=5000');
    expect(list.data).toHaveLength(1);
    expect(list.data[0].totalOwed).toBe(50000);
  });

  it('flags overdue invoices', async () => {
    await billEveryone();

    // The structure's due date is 2025-10-15, comfortably in the past.
    const list = await debtors('?overdueOnly=true');
    expect(list.data).toHaveLength(2);
    expect(list.data[0].isOverdue).toBe(true);
  });

  it('searches debtors by name and admission number', async () => {
    await billEveryone();

    const byName = await debtors('?search=obi');
    expect(byName.data).toHaveLength(1);
    expect(byName.data[0].studentName).toBe('Obi, Ada');

    const byNumber = await debtors(`?search=${students[1].studentId}`);
    expect(byNumber.data).toHaveLength(1);
  });

  it('lists guardian contacts on each debtor', async () => {
    await billEveryone();
    const guardian = await ctx
      .http()
      .post('/api/guardians')
      .set(auth())
      .send({
        firstName: 'Emeka',
        lastName: 'Obi',
        phone: '08031234567',
        email: 'emeka@example.com',
      })
      .expect(201);
    await ctx
      .http()
      .post(`/api/students/${students[0].id}/guardians`)
      .set(auth())
      .send({ guardianId: guardian.body.id, relationship: 'FATHER' })
      .expect(201);

    const list = await debtors('?search=obi');
    expect(list.data[0].guardianContacts).toEqual(['emeka@example.com']);
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  it('never reports another school’s money', async () => {
    await billEveryone();

    const report = await ctx
      .http()
      .get('/api/finance/reports/summary')
      .set(bearer(other.accessToken))
      .expect(200);
    expect(report.body).toMatchObject({ invoiceCount: 0, totalBilled: 0 });

    const list = await ctx
      .http()
      .get('/api/finance/reports/debtors')
      .set(bearer(other.accessToken))
      .expect(200);
    expect(list.body.data).toHaveLength(0);
  });
});
