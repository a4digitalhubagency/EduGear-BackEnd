import {
  closeTestApp,
  createTestApp,
  registerSchool,
  RegisteredSchool,
  resetDatabase,
  TestContext,
} from './utils/test-app';

describe('Fee reminders', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let structureId: string;
  let ada: string;
  let bola: string;
  let chidi: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const auth = () => bearer(school.accessToken);

  const remind = (body: Record<string, unknown> = {}) =>
    ctx.http().post('/api/finance/reminders').set(auth()).send(body);

  async function student(firstName: string, lastName: string) {
    return (
      await ctx
        .http()
        .post('/api/students')
        .set(auth())
        .send({
          firstName,
          lastName,
          gender: 'FEMALE',
          admissionDate: '2025-09-15',
        })
        .expect(201)
    ).body.id as string;
  }

  async function guardian(
    firstName: string,
    email: string | null,
    phone: string,
  ) {
    return (
      await ctx
        .http()
        .post('/api/guardians')
        .set(auth())
        .send({
          firstName,
          lastName: 'Parent',
          phone,
          ...(email ? { email } : {}),
        })
        .expect(201)
    ).body.id as string;
  }

  const link = (studentId: string, guardianId: string) =>
    ctx
      .http()
      .post(`/api/students/${studentId}/guardians`)
      .set(auth())
      .send({ guardianId, relationship: 'FATHER' })
      .expect(201);

  async function invoiceOf(studentId: string): Promise<string> {
    const invoices = await ctx
      .http()
      .get(`/api/finance/invoices?studentId=${studentId}`)
      .set(auth())
      .expect(200);
    return invoices.body.data[0].id;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Reminder College' });
    other = await registerSchool(ctx, { schoolName: 'Rival Academy' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.db.feeReminder.deleteMany({});
    await ctx.db.payment.deleteMany({});
    await ctx.db.studentFeeItem.deleteMany({});
    await ctx.db.studentFee.deleteMany({});
    await ctx.db.feeStructureItem.deleteMany({});
    await ctx.db.feeStructure.deleteMany({});
    await ctx.db.feeCategory.deleteMany({});
    await ctx.db.studentGuardian.deleteMany({});
    await ctx.db.guardian.deleteMany({});
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
    const category = await ctx
      .http()
      .post('/api/finance/fee-categories')
      .set(auth())
      .send({ name: 'Tuition' })
      .expect(201);
    structureId = (
      await ctx
        .http()
        .post('/api/finance/fee-structures')
        .set(auth())
        .send({
          name: 'First Term',
          sessionId: session.body.id,
          dueDate: '2025-10-15',
          items: [{ categoryId: category.body.id, amount: 50000 }],
        })
        .expect(201)
    ).body.id;
    await ctx
      .http()
      .post(`/api/finance/fee-structures/${structureId}/publish`)
      .set(auth())
      .expect(200);

    // Ada and Bola are siblings with one parent; Chidi's parent has no email.
    ada = await student('Ada', 'Okafor');
    bola = await student('Bola', 'Okafor');
    chidi = await student('Chidi', 'Eze');

    const emeka = await guardian('Emeka', 'emeka@example.com', '08031234567');
    await link(ada, emeka);
    await link(bola, emeka);
    await link(chidi, await guardian('Uche', null, '08099998888'));

    await ctx
      .http()
      .post('/api/finance/invoices/assign')
      .set(auth())
      .send({ structureId, studentIds: [ada, bola, chidi] })
      .expect(201);
  });

  it('sends a parent one email covering all their children', async () => {
    const response = await remind({ dryRun: true }).expect(200);

    expect(response.body).toMatchObject({
      dryRun: true,
      batchId: null,
      debtors: 3,
      sent: 1,
      studentsReminded: 2,
    });
    const [recipient] = response.body.recipients;
    expect(recipient).toMatchObject({
      email: 'emeka@example.com',
      totalOwed: 100000,
      delivered: null,
    });
    expect(
      recipient.children
        .map((c: { studentName: string }) => c.studentName)
        .sort(),
    ).toEqual(['Okafor, Ada', 'Okafor, Bola']);
  });

  it('returns unreachable families with phone numbers to call', async () => {
    const response = await remind({ dryRun: true }).expect(200);

    expect(response.body.skippedNoEmail).toBe(1);
    expect(response.body.unreachable[0]).toMatchObject({
      studentName: 'Eze, Chidi',
      amountOwed: 50000,
      guardianPhones: ['08099998888'],
    });
  });

  it('chases only what is not already awaiting verification', async () => {
    await ctx
      .http()
      .post('/api/finance/payments')
      .set(auth())
      .send({
        studentFeeId: await invoiceOf(ada),
        amount: 20000,
        method: 'BANK_TRANSFER',
        paidAt: '2025-10-01T10:00:00Z',
      })
      .expect(201);

    const response = await remind({ dryRun: true }).expect(200);
    const children = response.body.recipients[0].children;
    const adaLine = children.find(
      (c: { studentName: string }) => c.studentName === 'Okafor, Ada',
    );
    expect(adaLine.amountOwed).toBe(30000);
    expect(response.body.recipients[0].totalOwed).toBe(80000);
  });

  it('does not chase a parent whose pending payment covers the balance', async () => {
    for (const studentId of [ada, bola]) {
      await ctx
        .http()
        .post('/api/finance/payments')
        .set(auth())
        .send({
          studentFeeId: await invoiceOf(studentId),
          amount: 50000,
          method: 'BANK_TRANSFER',
          paidAt: '2025-10-01T10:00:00Z',
        })
        .expect(201);
    }

    const response = await remind({ dryRun: true }).expect(200);
    expect(response.body.recipients).toHaveLength(0);
    expect(
      response.body.skipped.map((s: { reason: string }) => s.reason),
    ).toEqual(['PAYMENT_PENDING', 'PAYMENT_PENDING']);
  });

  it('sends, logs each child, and stamps the debtor list', async () => {
    const response = await remind({
      message: 'Kindly settle before resumption.',
    }).expect(200);

    expect(response.body.dryRun).toBe(false);
    expect(response.body.batchId).toBeTruthy();
    expect(response.body.recipients[0].delivered).toBe(true);

    const logged = await ctx.db.feeReminder.findMany({
      where: { batchId: response.body.batchId },
    });
    // One row per child reminded, so each child's history is complete.
    expect(logged).toHaveLength(2);
    expect(logged.every((row) => row.status === 'SENT')).toBe(true);

    const debtors = await ctx
      .http()
      .get('/api/finance/reports/debtors')
      .set(auth())
      .expect(200);
    const adaRow = debtors.body.data.find(
      (d: { studentName: string }) => d.studentName === 'Okafor, Ada',
    );
    expect(adaRow.lastRemindedAt).toBeTruthy();
    const chidiRow = debtors.body.data.find(
      (d: { studentName: string }) => d.studentName === 'Eze, Chidi',
    );
    expect(chidiRow.lastRemindedAt).toBeNull();
  });

  it('will not remind the same family twice inside the cooldown', async () => {
    await remind().expect(200);

    const again = await remind().expect(200);
    expect(again.body.sent).toBe(0);
    expect(again.body.skipped.map((s: { reason: string }) => s.reason)).toEqual(
      ['RECENTLY_REMINDED', 'RECENTLY_REMINDED'],
    );
    expect(again.body.skipped[0].detail).toMatch(/cooldown is 7 day/);
  });

  it('lets the cooldown be switched off deliberately', async () => {
    await remind().expect(200);

    const again = await remind({ cooldownDays: 0 }).expect(200);
    expect(again.body.sent).toBe(1);
  });

  it('restricts to named students', async () => {
    const response = await remind({ dryRun: true, studentIds: [ada] }).expect(
      200,
    );
    expect(response.body.recipients[0].children).toHaveLength(1);
    expect(response.body.unreachable).toHaveLength(0);
  });

  it('keeps a readable history', async () => {
    const sent = await remind().expect(200);

    const history = await ctx
      .http()
      .get(`/api/finance/reminders?studentId=${ada}`)
      .set(auth())
      .expect(200);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0]).toMatchObject({
      batchId: sent.body.batchId,
      email: 'emeka@example.com',
      amountOwed: 50000,
      status: 'SENT',
    });
  });

  it('audits a real send but not a dry run', async () => {
    // Other tests in this suite send too, so measure the change.
    const entries = () =>
      ctx.db.auditLog.count({
        where: { schoolId: school.schoolId, action: 'payment.reminders_sent' },
      });
    const before = await entries();

    await remind({ dryRun: true }).expect(200);
    expect(await entries()).toBe(before);

    await remind().expect(200);
    expect(await entries()).toBe(before + 1);

    const latest = await ctx.db.auditLog.findFirst({
      where: { schoolId: school.schoolId, action: 'payment.reminders_sent' },
      orderBy: { createdAt: 'desc' },
    });
    expect(latest?.metadata).toMatchObject({ sent: 1, skippedNoEmail: 1 });
  });

  it('rejects a cooldown outside 0–90 days', async () => {
    await remind({ cooldownDays: 91 }).expect(400);
  });

  it('never reminds another school’s debtors', async () => {
    const response = await ctx
      .http()
      .post('/api/finance/reminders')
      .set(bearer(other.accessToken))
      .send({ dryRun: true })
      .expect(200);
    expect(response.body.debtors).toBe(0);

    const history = await ctx
      .http()
      .get('/api/finance/reminders')
      .set(bearer(other.accessToken))
      .expect(200);
    expect(history.body.data).toHaveLength(0);
  });
});
