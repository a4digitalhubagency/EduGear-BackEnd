import { MembershipStatus, UserStatus } from '@prisma/client';
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
 * The money path end to end: assign an invoice, pay it, verify it, and watch
 * the balance follow — plus the reversals that have to work when it doesn't.
 */
describe('Invoices and payments', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let teacherToken: string;
  let armId: string;
  let structureId: string;
  let optionalItemId: string;
  let students: { id: string; studentId: string }[];

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const auth = () => bearer(school.accessToken);

  const assign = (body: Record<string, unknown>) =>
    ctx.http().post('/api/finance/invoices/assign').set(auth()).send(body);

  const pay = (body: Record<string, unknown>) =>
    ctx
      .http()
      .post('/api/finance/payments')
      .set(auth())
      .send({
        method: 'BANK_TRANSFER',
        paidAt: '2025-10-01T10:00:00Z',
        ...body,
      });

  const invoiceOf = async (id: string) =>
    (
      await ctx
        .http()
        .get(`/api/finance/invoices/${id}`)
        .set(auth())
        .expect(200)
    ).body;

  async function firstInvoice(): Promise<string> {
    const result = await assign({ structureId, classArmId: armId }).expect(201);
    return result.body.invoices[0].id;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Payments College' });
    other = await registerSchool(ctx, { schoolName: 'Rival Academy' });

    const role = await ctx.db.role.findFirstOrThrow({
      where: { schoolId: school.schoolId, slug: 'TEACHER' },
    });
    const user = await ctx.db.user.create({
      data: {
        email: 'teacher@payments.test',
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
      .send({ email: 'teacher@payments.test', password: 'StrongPass123' })
      .expect(200);
    teacherToken = login.body.tokens.accessToken;
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
    const bus = await ctx
      .http()
      .post('/api/finance/fee-categories')
      .set(auth())
      .send({ name: 'Bus' })
      .expect(201);

    const structure = await ctx
      .http()
      .post('/api/finance/fee-structures')
      .set(auth())
      .send({
        name: 'JSS1 First Term',
        sessionId: session.body.id,
        items: [
          { categoryId: tuition.body.id, amount: 50000 },
          { categoryId: bus.body.id, amount: 15000, isOptional: true },
        ],
      })
      .expect(201);
    structureId = structure.body.id;
    optionalItemId = structure.body.items.find(
      (i: { isOptional: boolean }) => i.isOptional,
    ).id;

    await ctx
      .http()
      .post(`/api/finance/fee-structures/${structureId}/publish`)
      .set(auth())
      .expect(200);
  });

  // -------------------------------------------------------------------------
  // Assignment
  // -------------------------------------------------------------------------

  it('invoices a whole arm', async () => {
    const response = await assign({ structureId, classArmId: armId }).expect(
      201,
    );

    expect(response.body).toMatchObject({
      assigned: 2,
      skipped: 0,
      totalBilled: 100000,
    });
    expect(response.body.invoices[0]).toMatchObject({
      totalAmount: 50000,
      balance: 50000,
      status: 'UNPAID',
    });
  });

  it('skips students already invoiced instead of failing', async () => {
    await assign({ structureId, classArmId: armId }).expect(201);

    // A late arrival joins the arm and the assignment is re-run.
    const late = await ctx
      .http()
      .post('/api/students')
      .set(auth())
      .send({
        firstName: 'Chidi',
        lastName: 'New',
        gender: 'MALE',
        admissionDate: '2025-10-01',
        classArmId: armId,
      })
      .expect(201);

    const response = await assign({ structureId, classArmId: armId }).expect(
      201,
    );
    expect(response.body).toMatchObject({ assigned: 1, skipped: 2 });
    expect(response.body.invoices[0].studentId).toBe(late.body.id);
  });

  it('bills optional items only when asked', async () => {
    const withBus = await assign({
      structureId,
      studentIds: [students[0].id],
      includeOptionalItemIds: [optionalItemId],
    }).expect(201);
    expect(withBus.body.invoices[0].totalAmount).toBe(65000);

    const without = await assign({
      structureId,
      studentIds: [students[1].id],
    }).expect(201);
    expect(without.body.invoices[0].totalAmount).toBe(50000);
    expect(without.body.invoices[0].items).toHaveLength(1);
  });

  it('rejects an optional item from another structure', async () => {
    await assign({
      structureId,
      studentIds: [students[0].id],
      includeOptionalItemIds: ['11111111-1111-4111-8111-111111111111'],
    }).expect(400);
  });

  it('refuses to assign a draft structure', async () => {
    const draft = await ctx
      .http()
      .post('/api/finance/fee-structures')
      .set(auth())
      .send({
        name: 'Unpublished',
        sessionId: (
          await ctx
            .http()
            .get('/api/academics/sessions/current')
            .set(auth())
            .expect(200)
        ).body.id,
        items: [
          {
            categoryId: (
              await ctx
                .http()
                .get('/api/finance/fee-categories')
                .set(auth())
                .expect(200)
            ).body.data[0].id,
            amount: 100,
          },
        ],
      })
      .expect(201);

    const response = await assign({
      structureId: draft.body.id,
      classArmId: armId,
    }).expect(409);
    expect(response.body.message).toMatch(/PUBLISHED/);
  });

  it('rejects both an arm and a student list', async () => {
    await assign({
      structureId,
      classArmId: armId,
      studentIds: [students[0].id],
    }).expect(400);
  });

  it('does not bill withdrawn students', async () => {
    await ctx
      .http()
      .patch(`/api/students/${students[0].id}/status`)
      .set(auth())
      .send({ status: 'WITHDRAWN' })
      .expect(200);

    const response = await assign({ structureId, classArmId: armId }).expect(
      201,
    );
    expect(response.body.assigned).toBe(1);
  });

  it('freezes the bill against later structure edits', async () => {
    const invoiceId = await firstInvoice();

    // Amounts are locked once invoices exist.
    await ctx
      .http()
      .patch(`/api/finance/fee-structures/${structureId}`)
      .set(auth())
      .send({ items: [{ categoryId: students[0].id, amount: 1 }] })
      .expect(409);

    expect((await invoiceOf(invoiceId)).totalAmount).toBe(50000);
  });

  // -------------------------------------------------------------------------
  // Payment and verification
  // -------------------------------------------------------------------------

  it('records a payment as PENDING without moving the balance', async () => {
    const invoiceId = await firstInvoice();

    const payment = await pay({
      studentFeeId: invoiceId,
      amount: 20000,
    }).expect(201);

    expect(payment.body).toMatchObject({
      status: 'PENDING',
      receiptNumber: null,
    });
    expect((await invoiceOf(invoiceId)).balance).toBe(50000);
  });

  it('moves the balance and issues a receipt on verification', async () => {
    const invoiceId = await firstInvoice();
    const payment = await pay({
      studentFeeId: invoiceId,
      amount: 20000,
    }).expect(201);

    const verified = await ctx
      .http()
      .post(`/api/finance/payments/${payment.body.id}/verify`)
      .set(auth())
      .expect(200);

    expect(verified.body.status).toBe('VERIFIED');
    expect(verified.body.receiptNumber).toBe('RCP/2025/000001');

    const invoice = await invoiceOf(invoiceId);
    expect(invoice).toMatchObject({
      amountPaid: 20000,
      balance: 30000,
      status: 'PARTIAL',
    });
  });

  it('settles an invoice when fully paid', async () => {
    const invoiceId = await firstInvoice();
    const first = await pay({ studentFeeId: invoiceId, amount: 30000 }).expect(
      201,
    );
    const second = await pay({ studentFeeId: invoiceId, amount: 20000 }).expect(
      201,
    );

    for (const id of [first.body.id, second.body.id]) {
      await ctx
        .http()
        .post(`/api/finance/payments/${id}/verify`)
        .set(auth())
        .expect(200);
    }

    const invoice = await invoiceOf(invoiceId);
    expect(invoice).toMatchObject({ balance: 0, status: 'PAID' });
  });

  it('numbers receipts sequentially', async () => {
    const invoiceId = await firstInvoice();
    const a = await pay({ studentFeeId: invoiceId, amount: 10000 }).expect(201);
    const b = await pay({ studentFeeId: invoiceId, amount: 10000 }).expect(201);

    const first = await ctx
      .http()
      .post(`/api/finance/payments/${a.body.id}/verify`)
      .set(auth())
      .expect(200);
    const second = await ctx
      .http()
      .post(`/api/finance/payments/${b.body.id}/verify`)
      .set(auth())
      .expect(200);

    expect(first.body.receiptNumber).toBe('RCP/2025/000001');
    expect(second.body.receiptNumber).toBe('RCP/2025/000002');
  });

  it('refuses to overpay an invoice', async () => {
    const invoiceId = await firstInvoice();

    const response = await pay({
      studentFeeId: invoiceId,
      amount: 50001,
    }).expect(400);
    expect(response.body.message).toMatch(/still outstanding/);
  });

  it('counts pending payments toward the ceiling', async () => {
    const invoiceId = await firstInvoice();
    await pay({ studentFeeId: invoiceId, amount: 50000 }).expect(201);

    // The first is unverified, but the money is already claimed.
    await pay({ studentFeeId: invoiceId, amount: 50000 }).expect(400);
  });

  it('reverses the balance when a verified payment is rejected', async () => {
    const invoiceId = await firstInvoice();
    const payment = await pay({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);
    await ctx
      .http()
      .post(`/api/finance/payments/${payment.body.id}/verify`)
      .set(auth())
      .expect(200);
    expect((await invoiceOf(invoiceId)).status).toBe('PAID');

    await ctx
      .http()
      .post(`/api/finance/payments/${payment.body.id}/reject`)
      .set(auth())
      .send({ reason: 'No matching credit on the statement' })
      .expect(200);

    const invoice = await invoiceOf(invoiceId);
    expect(invoice).toMatchObject({
      amountPaid: 0,
      balance: 50000,
      status: 'UNPAID',
    });
  });

  it('refuses to verify twice', async () => {
    const invoiceId = await firstInvoice();
    const payment = await pay({
      studentFeeId: invoiceId,
      amount: 10000,
    }).expect(201);
    await ctx
      .http()
      .post(`/api/finance/payments/${payment.body.id}/verify`)
      .set(auth())
      .expect(200);

    await ctx
      .http()
      .post(`/api/finance/payments/${payment.body.id}/verify`)
      .set(auth())
      .expect(409);
  });

  it('refuses to verify a rejected payment', async () => {
    const invoiceId = await firstInvoice();
    const payment = await pay({
      studentFeeId: invoiceId,
      amount: 10000,
    }).expect(201);
    await ctx
      .http()
      .post(`/api/finance/payments/${payment.body.id}/reject`)
      .set(auth())
      .send({ reason: 'Duplicate entry' })
      .expect(200);

    await ctx
      .http()
      .post(`/api/finance/payments/${payment.body.id}/verify`)
      .set(auth())
      .expect(409);
  });

  it('searches payments by receipt number and student', async () => {
    const invoiceId = await firstInvoice();
    const payment = await pay({
      studentFeeId: invoiceId,
      amount: 10000,
      reference: 'TRF-99881',
    }).expect(201);
    await ctx
      .http()
      .post(`/api/finance/payments/${payment.body.id}/verify`)
      .set(auth())
      .expect(200);

    const byReceipt = await ctx
      .http()
      .get('/api/finance/payments?search=RCP/2025/000001')
      .set(auth())
      .expect(200);
    expect(byReceipt.body.data).toHaveLength(1);

    const byReference = await ctx
      .http()
      .get('/api/finance/payments?search=TRF-99881')
      .set(auth())
      .expect(200);
    expect(byReference.body.data).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Discounts, waivers and cancellation
  // -------------------------------------------------------------------------

  it('applies a discount and reduces what is payable', async () => {
    const invoiceId = await firstInvoice();

    const response = await ctx
      .http()
      .post(`/api/finance/invoices/${invoiceId}/discount`)
      .set(auth())
      .send({ amount: 10000, reason: 'Sibling discount' })
      .expect(200);

    expect(response.body).toMatchObject({
      totalAmount: 50000,
      discountAmount: 10000,
      payableAmount: 40000,
      balance: 40000,
    });
  });

  it('settles an invoice once the discount and payments cover it', async () => {
    const invoiceId = await firstInvoice();
    await ctx
      .http()
      .post(`/api/finance/invoices/${invoiceId}/discount`)
      .set(auth())
      .send({ amount: 20000, reason: 'Scholarship' })
      .expect(200);

    const payment = await pay({
      studentFeeId: invoiceId,
      amount: 30000,
    }).expect(201);
    await ctx
      .http()
      .post(`/api/finance/payments/${payment.body.id}/verify`)
      .set(auth())
      .expect(200);

    expect((await invoiceOf(invoiceId)).status).toBe('PAID');
  });

  it('rejects a discount larger than the bill', async () => {
    const invoiceId = await firstInvoice();

    await ctx
      .http()
      .post(`/api/finance/invoices/${invoiceId}/discount`)
      .set(auth())
      .send({ amount: 50001, reason: 'Too much' })
      .expect(400);
  });

  it('waives an invoice and refuses payments against it', async () => {
    const invoiceId = await firstInvoice();

    const waived = await ctx
      .http()
      .post(`/api/finance/invoices/${invoiceId}/waive`)
      .set(auth())
      .send({ reason: 'Staff child' })
      .expect(200);
    expect(waived.body.status).toBe('WAIVED');

    await pay({ studentFeeId: invoiceId, amount: 1000 }).expect(409);
  });

  it('refuses to cancel an invoice with payments against it', async () => {
    const invoiceId = await firstInvoice();
    const payment = await pay({
      studentFeeId: invoiceId,
      amount: 10000,
    }).expect(201);
    await ctx
      .http()
      .post(`/api/finance/payments/${payment.body.id}/verify`)
      .set(auth())
      .expect(200);

    const response = await ctx
      .http()
      .post(`/api/finance/invoices/${invoiceId}/cancel`)
      .set(auth())
      .send({ reason: 'Raised in error' })
      .expect(409);
    expect(response.body.message).toMatch(/Reject those payments/);
  });

  // -------------------------------------------------------------------------
  // Authorization and tenant isolation
  // -------------------------------------------------------------------------

  it('lets a teacher neither read nor verify finance', async () => {
    await ctx
      .http()
      .get('/api/finance/invoices')
      .set(bearer(teacherToken))
      .expect(403);
  });

  it('refuses verification to a role without finance.verify', async () => {
    const invoiceId = await firstInvoice();
    const payment = await pay({
      studentFeeId: invoiceId,
      amount: 1000,
    }).expect(201);

    await ctx
      .http()
      .post(`/api/finance/payments/${payment.body.id}/verify`)
      .set(bearer(teacherToken))
      .expect(403);
  });

  it('never shows another school its neighbour’s invoices', async () => {
    await firstInvoice();

    const response = await ctx
      .http()
      .get('/api/finance/invoices')
      .set(bearer(other.accessToken))
      .expect(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('404s when another school tries to pay an invoice', async () => {
    const invoiceId = await firstInvoice();

    await ctx
      .http()
      .post('/api/finance/payments')
      .set(bearer(other.accessToken))
      .send({
        studentFeeId: invoiceId,
        amount: 1000,
        method: 'CASH',
        paidAt: '2025-10-01T10:00:00Z',
      })
      .expect(404);
  });
});
