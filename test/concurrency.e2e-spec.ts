import {
  closeTestApp,
  createTestApp,
  registerSchool,
  RegisteredSchool,
  resetDatabase,
  TestContext,
} from './utils/test-app';

/**
 * Check-then-write races. Each test fires requests in parallel and asserts an
 * invariant that must hold however the database interleaves them. Rows are
 * locked (SELECT … FOR UPDATE) before the check, so the second writer waits for
 * the first to commit and then sees its effect.
 */
describe('Concurrency', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let armId: string;
  let invoiceId: string;
  let structureId: string;

  const auth = () => ({ Authorization: `Bearer ${school.accessToken}` });

  const pay = (amount: number) =>
    ctx.http().post('/api/finance/payments').set(auth()).send({
      studentFeeId: invoiceId,
      amount,
      method: 'CASH',
      paidAt: '2025-10-01T10:00:00Z',
    });

  const verify = (paymentId: string) =>
    ctx.http().post(`/api/finance/payments/${paymentId}/verify`).set(auth());

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Race College' });
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
    const klass = await ctx
      .http()
      .post('/api/academics/classes')
      .set(auth())
      .send({ name: 'JSS1', level: 1 })
      .expect(201);
    armId = (
      await ctx
        .http()
        .post('/api/academics/class-arms')
        .set(auth())
        .send({ classId: klass.body.id, name: 'A', capacity: 1 })
        .expect(201)
    ).body.id;

    const student = await ctx
      .http()
      .post('/api/students')
      .set(auth())
      .send({
        firstName: 'Ada',
        lastName: 'Obi',
        gender: 'FEMALE',
        admissionDate: '2025-09-15',
      })
      .expect(201);

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
        name: 'Term fees',
        sessionId: session.body.id,
        items: [{ categoryId: category.body.id, amount: 50000 }],
      })
      .expect(201);
    await ctx
      .http()
      .post(`/api/finance/fee-structures/${structure.body.id}/publish`)
      .set(auth())
      .expect(200);

    structureId = structure.body.id as string;

    invoiceId = (
      await ctx
        .http()
        .post('/api/finance/invoices/assign')
        .set(auth())
        .send({ structureId: structure.body.id, studentIds: [student.body.id] })
        .expect(201)
    ).body.invoices[0].id;
  });

  it('never loses a payment when two are verified at once', async () => {
    const payments = await Promise.all(
      [10000, 15000, 5000, 20000].map(
        async (amount) => (await pay(amount).expect(201)).body.id,
      ),
    );

    const results = await Promise.all(payments.map((id) => verify(id)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);

    const invoice = await ctx.db.studentFee.findUniqueOrThrow({
      where: { id: invoiceId },
    });
    // Every verified payment is counted, whatever order they committed in.
    expect(invoice.amountPaid.toNumber()).toBe(50000);
    expect(invoice.status).toBe('PAID');

    const receipts = await ctx.db.payment.findMany({
      select: { receiptNumber: true },
    });
    expect(new Set(receipts.map((r) => r.receiptNumber)).size).toBe(4);
  });

  it('accepts only one of two payments that each claim the full balance', async () => {
    const results = await Promise.all([pay(50000), pay(50000)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
  });

  it('verifies a payment exactly once under a double-click', async () => {
    const paymentId = (await pay(20000).expect(201)).body.id;

    const results = await Promise.all([verify(paymentId), verify(paymentId)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

    const invoice = await ctx.db.studentFee.findUniqueOrThrow({
      where: { id: invoiceId },
    });
    expect(invoice.amountPaid.toNumber()).toBe(20000);
  });

  it('fills the last seat in an arm only once', async () => {
    const admit = (firstName: string) =>
      ctx.http().post('/api/students').set(auth()).send({
        firstName,
        lastName: 'Race',
        gender: 'MALE',
        admissionDate: '2025-09-15',
        classArmId: armId,
      });

    const results = await Promise.all([
      admit('One'),
      admit('Two'),
      admit('Three'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);

    expect(await ctx.db.student.count({ where: { classArmId: armId } })).toBe(
      1,
    );
  });

  // ---------------------------------------------------------------------------
  // Generated identifiers
  //
  // A number is the highest existing one plus one, which is a maximum over
  // every row and therefore has no row to lock. Without a lock, every
  // concurrent writer read the same maximum, computed the same next number,
  // and all but one were refused by the unique index — and because each retry
  // recomputed the identical number, the retries collided too. Ten admissions
  // at once lost four; eight verifications lost two, leaving those payments
  // PENDING and the parents' balances untouched.
  // ---------------------------------------------------------------------------

  it('gives every simultaneous admission its own number', async () => {
    const admit = (n: number) =>
      ctx
        .http()
        .post('/api/students')
        .set(auth())
        .send({
          firstName: `Burst${n}`,
          lastName: 'Numbered',
          gender: 'FEMALE',
          admissionDate: '2025-09-15',
        });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => admit(i)),
    );

    // Not "most of them succeeded" — all of them. A registrar admitting a
    // class should not have rows fail for reasons that are nothing to do with
    // the data they typed.
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));

    const numbers = results.map((r) => r.body.studentId as string);
    expect(new Set(numbers).size).toBe(10);
  });

  it('gives every simultaneous verification its own receipt number', async () => {
    // Six *different* invoices, which is the whole point. Payments against
    // one invoice are already serialised by that invoice's row lock, so they
    // never contend for a receipt number and a test using one invoice proves
    // nothing — it passed with the serialisation removed. Different invoices
    // take different row locks, so nothing orders them but the receipt lock.
    // This is also the real case: a bursar clears a morning of transfers from
    // six different families.
    const students = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        ctx
          .http()
          .post('/api/students')
          .set(auth())
          .send({
            firstName: `Payer${i}`,
            lastName: 'Receipt',
            gender: 'MALE',
            admissionDate: '2025-09-15',
          })
          .expect(201),
      ),
    );

    const assigned = await ctx
      .http()
      .post('/api/finance/invoices/assign')
      .set(auth())
      .send({
        structureId,
        studentIds: students.map((s) => s.body.id as string),
      })
      .expect(201);
    const invoices = assigned.body.invoices as { id: string }[];
    expect(invoices).toHaveLength(6);

    const payments = await Promise.all(
      invoices.map((invoice) =>
        ctx.http().post('/api/finance/payments').set(auth()).send({
          studentFeeId: invoice.id,
          amount: 1000,
          method: 'BANK_TRANSFER',
          paidAt: '2025-10-01T10:00:00Z',
        }),
      ),
    );
    const ids = payments.map((p) => p.body.id as string);
    expect(new Set(ids).size).toBe(6);

    const verified = await Promise.all(ids.map((id) => verify(id)));

    // A bursar clearing a morning's bank transfers verifies a batch. A failure
    // here is money that stays PENDING while the screen looks finished.
    expect(verified.map((r) => r.status)).toEqual(Array(6).fill(200));

    const receipts = verified.map((r) => r.body.receiptNumber as string);
    expect(new Set(receipts).size).toBe(6);
    // And no gaps: a receipt book with holes is something somebody has to
    // explain to an auditor.
    const sequences = receipts
      .map((value) => Number(value.split('/').pop()))
      .sort((a, b) => a - b);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
