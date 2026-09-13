import {
  closeTestApp,
  createTestApp,
  registerSchool,
  RegisteredSchool,
  resetDatabase,
  TestContext,
} from './utils/test-app';

describe('Receipts and statements', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let studentId: string;
  let invoiceId: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const auth = () => bearer(school.accessToken);

  async function payAndVerify(amount: number, paidAt: string) {
    const payment = await ctx
      .http()
      .post('/api/finance/payments')
      .set(auth())
      .send({
        studentFeeId: invoiceId,
        amount,
        method: 'BANK_TRANSFER',
        reference: `TRF-${amount}`,
        paidAt,
      })
      .expect(201);
    await ctx
      .http()
      .post(`/api/finance/payments/${payment.body.id}/verify`)
      .set(auth())
      .expect(200);
    return payment.body.id as string;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Receipts College' });
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
    await ctx.db.student.deleteMany({});
    await ctx.db.academicSession.deleteMany({});

    const session = await ctx
      .http()
      .post('/api/academics/sessions')
      .set(auth())
      .send({
        name: '2025/2026',
        startDate: '2025-09-15',
        endDate: '2026-07-24',
      })
      .expect(201);

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
        })
        .expect(201)
    ).body.id;

    const category = await ctx
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
        name: 'First Term Fees',
        sessionId: session.body.id,
        items: [{ categoryId: category.body.id, amount: 50000 }],
      })
      .expect(201);
    await ctx
      .http()
      .post(`/api/finance/fee-structures/${structure.body.id}/publish`)
      .set(auth())
      .expect(200);

    invoiceId = (
      await ctx
        .http()
        .post('/api/finance/invoices/assign')
        .set(auth())
        .send({ structureId: structure.body.id, studentIds: [studentId] })
        .expect(201)
    ).body.invoices[0].id;
  });

  // -------------------------------------------------------------------------
  // Receipts
  // -------------------------------------------------------------------------

  it('issues a receipt for a verified payment', async () => {
    const paymentId = await payAndVerify(20000, '2025-10-01T10:00:00Z');

    const response = await ctx
      .http()
      .get(`/api/finance/payments/${paymentId}/receipt`)
      .set(auth())
      .expect(200);

    expect(response.body).toMatchObject({
      receiptNumber: 'RCP/2025/000001',
      amount: 20000,
      amountInWords: 'Twenty thousand naira only',
      method: 'BANK_TRANSFER',
      reference: 'TRF-20000',
      invoicePayable: 50000,
      paidToDate: 20000,
      balanceAfter: 30000,
      feeDescription: 'First Term Fees (2025/2026)',
    });
    expect(response.body.school.name).toBe('Receipts College');
    expect(response.body.student.fullName).toBe('Obi, Ada');
    expect(response.body.receivedBy).toBeTruthy();
  });

  it('keeps a receipt’s balance fixed when later payments arrive', async () => {
    const first = await payAndVerify(20000, '2025-10-01T10:00:00Z');
    await payAndVerify(30000, '2025-11-01T10:00:00Z');

    const reprint = await ctx
      .http()
      .get(`/api/finance/payments/${first}/receipt`)
      .set(auth())
      .expect(200);

    // Still the balance as it stood when the first payment cleared.
    expect(reprint.body.balanceAfter).toBe(30000);
  });

  it('has no receipt for a pending payment', async () => {
    const payment = await ctx
      .http()
      .post('/api/finance/payments')
      .set(auth())
      .send({
        studentFeeId: invoiceId,
        amount: 1000,
        method: 'CASH',
        paidAt: '2025-10-01T10:00:00Z',
      })
      .expect(201);

    const response = await ctx
      .http()
      .get(`/api/finance/payments/${payment.body.id}/receipt`)
      .set(auth())
      .expect(409);
    expect(response.body.message).toMatch(/Only a verified payment/);
  });

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  it('builds a running-balance statement', async () => {
    await payAndVerify(20000, '2025-10-01T10:00:00Z');
    await payAndVerify(10000, '2025-11-01T10:00:00Z');

    const response = await ctx
      .http()
      .get(`/api/finance/students/${studentId}/statement`)
      .set(auth())
      .expect(200);

    expect(response.body).toMatchObject({
      totalBilled: 50000,
      totalPaid: 30000,
      closingBalance: 20000,
      pendingVerification: 0,
    });
    expect(
      response.body.ledger.map((e: { balance: number }) => e.balance),
    ).toEqual([50000, 30000, 20000]);
  });

  it('shows pending payments separately from money received', async () => {
    await ctx
      .http()
      .post('/api/finance/payments')
      .set(auth())
      .send({
        studentFeeId: invoiceId,
        amount: 5000,
        method: 'CASH',
        paidAt: '2025-10-01T10:00:00Z',
      })
      .expect(201);

    const response = await ctx
      .http()
      .get(`/api/finance/students/${studentId}/statement`)
      .set(auth())
      .expect(200);

    expect(response.body.closingBalance).toBe(50000);
    expect(response.body.pendingVerification).toBe(5000);
    expect(response.body.payments[0]).toMatchObject({
      status: 'PENDING',
      receiptNumber: null,
    });
  });

  it('closes a waived invoice at zero', async () => {
    await payAndVerify(20000, '2025-10-01T10:00:00Z');
    await ctx
      .http()
      .post(`/api/finance/invoices/${invoiceId}/waive`)
      .set(auth())
      .send({ reason: 'Scholarship awarded' })
      .expect(200);

    const response = await ctx
      .http()
      .get(`/api/finance/students/${studentId}/statement`)
      .set(auth())
      .expect(200);

    expect(response.body).toMatchObject({
      totalWaived: 30000,
      closingBalance: 0,
    });
  });

  it('never shows another school’s receipts or statements', async () => {
    const paymentId = await payAndVerify(20000, '2025-10-01T10:00:00Z');

    await ctx
      .http()
      .get(`/api/finance/payments/${paymentId}/receipt`)
      .set(bearer(other.accessToken))
      .expect(404);
    await ctx
      .http()
      .get(`/api/finance/students/${studentId}/statement`)
      .set(bearer(other.accessToken))
      .expect(404);
  });
});
