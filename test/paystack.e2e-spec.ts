import { createHmac } from 'node:crypto';
import { MembershipStatus, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { EmailService } from '../src/notifications/email.service';
import { PaymentsService } from '../src/finance/payments.service';
import {
  InitializedTransaction,
  PaystackClient,
  VerifiedTransaction,
} from '../src/finance/paystack/paystack.client';
import {
  closeTestApp,
  createTestApp,
  registerSchool,
  RegisteredSchool,
  resetDatabase,
  TestContext,
} from './utils/test-app';

const SECRET = 'sk_test_e2e_secret';

/**
 * Stands in for Paystack. It never reaches the network, it records what it was
 * asked for, and each test decides what the provider says back.
 */
class FakePaystackClient {
  configured = true;
  secretKey: string | undefined = SECRET;

  initializeCalls: {
    email: string;
    amountKobo: number;
    reference: string;
    metadata: Record<string, string>;
  }[] = [];
  verifyCalls: string[] = [];

  /** Replaced by tests that need a failure or a particular verdict. */
  onInitialize!: (params: {
    reference: string;
  }) => Promise<InitializedTransaction>;
  onVerify!: (reference: string) => Promise<VerifiedTransaction>;

  constructor() {
    this.reset();
  }

  initialize(params: {
    email: string;
    amountKobo: number;
    reference: string;
    metadata: Record<string, string>;
  }): Promise<InitializedTransaction> {
    this.initializeCalls.push(params);
    return this.onInitialize(params);
  }

  verify(reference: string): Promise<VerifiedTransaction> {
    this.verifyCalls.push(reference);
    return this.onVerify(reference);
  }

  /** Back to a working provider that has done nothing yet. */
  reset(): void {
    this.initializeCalls = [];
    this.verifyCalls = [];
    this.configured = true;
    this.secretKey = SECRET;
    this.onInitialize = ({ reference }) =>
      Promise.resolve({
        authorizationUrl: `https://checkout.paystack.com/${reference}`,
        accessCode: 'acc_123',
        reference,
      });
    this.onVerify = () =>
      Promise.resolve({
        status: 'abandoned',
        amountKobo: 0,
        currency: 'NGN',
        paidAt: null,
        channel: null,
      });
  }
}

/**
 * Online payments.
 *
 * The webhook is the part that matters: it is public, it moves money, and the
 * only thing standing between an attacker and a cleared school fee is the
 * signature over the raw body. These tests go at that first.
 */
describe('Paystack online payments', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  const paystack = new FakePaystackClient();
  let invitations: { to: string; token: string }[] = [];

  let armId: string;
  let structureId: string;
  let invoiceId: string;
  let studentId: string;
  let guardianId: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const auth = () => bearer(school.accessToken);

  const startOnline = (body: Record<string, unknown>) =>
    ctx.http().post('/api/finance/payments/online').set(auth()).send(body);

  /** Posts a webhook body signed exactly as Paystack would sign it. */
  const webhook = (body: unknown, signature?: string) => {
    const raw = JSON.stringify(body);
    return ctx
      .http()
      .post('/api/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set(
        'x-paystack-signature',
        signature ?? createHmac('sha512', SECRET).update(raw).digest('hex'),
      )
      .send(raw);
  };

  const chargeSuccess = (
    reference: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    event: 'charge.success',
    data: {
      id: 900_000 + Math.floor(Math.random() * 90_000),
      reference,
      amount: 5_000_000,
      currency: 'NGN',
      status: 'success',
      paid_at: '2025-10-02T09:00:00.000Z',
      channel: 'card',
      ...overrides,
    },
  });

  /** Ages a pending attempt past the point where it counts as abandoned. */
  const backdate = (id: string) =>
    ctx.db.payment.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - 60 * 60_000) },
    });

  const paymentRow = (id: string) =>
    ctx.db.payment.findUniqueOrThrow({ where: { id } });

  const invoiceRow = () =>
    ctx.db.studentFee.findUniqueOrThrow({ where: { id: invoiceId } });

  beforeAll(async () => {
    ctx = await createTestApp({
      overrides: [{ provide: PaystackClient, useValue: paystack }],
    });
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Paystack College' });
    other = await registerSchool(ctx, { schoolName: 'Rival Academy' });

    // Invitation links come from the mock rather than a mailbox.
    jest
      .spyOn(ctx.app.get(EmailService), 'sendParentInvitation')
      .mockImplementation((params) => {
        invitations.push({ to: params.to, token: params.token });
        return Promise.resolve();
      });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    paystack.reset();
    invitations = [];
    await ctx.db.webhookEvent.deleteMany({});
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

    const student = await ctx
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
      .expect(201);
    studentId = student.body.id;

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
        sessionId: session.body.id,
        items: [{ categoryId: tuition.body.id, amount: 50000 }],
      })
      .expect(201);
    structureId = structure.body.id;

    await ctx
      .http()
      .post(`/api/finance/fee-structures/${structureId}/publish`)
      .set(auth())
      .expect(200);

    const assigned = await ctx
      .http()
      .post('/api/finance/invoices/assign')
      .set(auth())
      .send({ structureId, classArmId: armId })
      .expect(201);
    invoiceId = assigned.body.invoices[0].id;
  });

  // -------------------------------------------------------------------------
  // Starting a payment
  // -------------------------------------------------------------------------

  it('creates a PENDING payment and returns a checkout link', async () => {
    const response = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);

    expect(response.body).toMatchObject({
      amount: 50000,
      authorizationUrl: expect.stringContaining('checkout.paystack.com'),
      reference: expect.stringMatching(/^EDU-/),
    });

    const payment = await paymentRow(response.body.paymentId);
    expect(payment.status).toBe('PENDING');
    expect(payment.method).toBe('ONLINE');
    expect(payment.providerReference).toBe(response.body.reference);

    // Nothing has moved: the payer has not paid yet.
    expect((await invoiceRow()).amountPaid.toNumber()).toBe(0);
  });

  it('asks the provider for kobo, not naira', async () => {
    await startOnline({ studentFeeId: invoiceId, amount: 1234.56 }).expect(201);
    expect(paystack.initializeCalls[0].amountKobo).toBe(123456);
  });

  it('refuses more than the invoice still owes', async () => {
    await startOnline({ studentFeeId: invoiceId, amount: 50000.01 }).expect(
      400,
    );
    expect(paystack.initializeCalls).toHaveLength(0);
  });

  it('counts an unfinished attempt against the ceiling', async () => {
    await startOnline({ studentFeeId: invoiceId, amount: 50000 }).expect(201);
    // The full balance is already spoken for by a pending attempt.
    await startOnline({ studentFeeId: invoiceId, amount: 50000 }).expect(400);
  });

  it('leaves no pending payment behind when the provider cannot be reached', async () => {
    paystack.onInitialize = () =>
      Promise.reject(new Error('Paystack refused the request (502)'));

    await startOnline({ studentFeeId: invoiceId, amount: 50000 }).expect(409);

    // Otherwise the abandoned row would block the payer's next attempt.
    expect(
      await ctx.db.payment.count({ where: { studentFeeId: invoiceId } }),
    ).toBe(0);
  });

  it('refuses when the school has no provider configured', async () => {
    paystack.configured = false;
    paystack.secretKey = undefined;

    await startOnline({ studentFeeId: invoiceId, amount: 50000 }).expect(409);
  });

  it('needs finance.create, not merely a login', async () => {
    const teacherToken = await loginAsTeacher();
    await ctx
      .http()
      .post('/api/finance/payments/online')
      .set(bearer(teacherToken))
      .send({ studentFeeId: invoiceId, amount: 1000 })
      .expect(403);
  });

  it('clears an abandoned attempt the provider never collected', async () => {
    const abandoned = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);
    await backdate(abandoned.body.paymentId);

    // The payer closed the browser an hour ago and is trying again.
    const retry = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);

    expect(paystack.verifyCalls).toEqual([abandoned.body.reference]);
    expect(
      await ctx.db.payment.findUnique({
        where: { id: abandoned.body.paymentId },
      }),
    ).toBeNull();
    expect(retry.body.paymentId).not.toBe(abandoned.body.paymentId);
  });

  it('settles an abandoned attempt that was paid after all, instead of clearing it', async () => {
    const paid = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);
    await backdate(paid.body.paymentId);

    paystack.onVerify = () =>
      Promise.resolve({
        status: 'success',
        amountKobo: 5_000_000,
        currency: 'NGN',
        paidAt: new Date('2025-10-02T09:00:00.000Z'),
        channel: 'card',
      });

    // The money is in: the invoice is settled, so there is nothing left to pay.
    await startOnline({ studentFeeId: invoiceId, amount: 50000 }).expect(400);

    expect((await paymentRow(paid.body.paymentId)).status).toBe('VERIFIED');
    expect((await invoiceRow()).amountPaid.toNumber()).toBe(50000);
  });

  it('leaves an abandoned attempt alone when the provider cannot be reached', async () => {
    const stale = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);
    await backdate(stale.body.paymentId);

    paystack.onVerify = () => Promise.reject(new Error('gateway timeout'));

    // Deleting a payment we cannot vouch for would be worse than refusing.
    await startOnline({ studentFeeId: invoiceId, amount: 50000 }).expect(400);
    expect((await paymentRow(stale.body.paymentId)).status).toBe('PENDING');
  });

  // -------------------------------------------------------------------------
  // The webhook
  // -------------------------------------------------------------------------

  it('settles a payment on a correctly signed charge.success', async () => {
    const started = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);

    const response = await webhook(chargeSuccess(started.body.reference));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'verified' });

    const payment = await paymentRow(started.body.paymentId);
    expect(payment.status).toBe('VERIFIED');
    // Numbered from the year the money came in, which is today's.
    expect(payment.receiptNumber).toMatch(
      new RegExp(`^RCP/${new Date().getUTCFullYear()}/\\d{6}$`),
    );
    expect(payment.verifiedAt).not.toBeNull();

    const invoice = await invoiceRow();
    expect(invoice.amountPaid.toNumber()).toBe(50000);
    expect(invoice.status).toBe('PAID');
  });

  it('rejects a forged signature and changes nothing', async () => {
    const started = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);

    await webhook(
      chargeSuccess(started.body.reference),
      'a'.repeat(128),
    ).expect(401);

    expect((await paymentRow(started.body.paymentId)).status).toBe('PENDING');
    expect((await invoiceRow()).amountPaid.toNumber()).toBe(0);
  });

  it('rejects a missing signature', async () => {
    const started = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);

    await ctx
      .http()
      .post('/api/webhooks/paystack')
      .send(chargeSuccess(started.body.reference))
      .expect(401);

    expect((await paymentRow(started.body.paymentId)).status).toBe('PENDING');
  });

  it('rejects a body tampered with after signing', async () => {
    const started = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);

    const original = chargeSuccess(started.body.reference, { amount: 100 });
    const signature = createHmac('sha512', SECRET)
      .update(JSON.stringify(original))
      .digest('hex');

    // Same signature, the amount raised to the full fee.
    const tampered = {
      ...original,
      data: { ...original.data, amount: 5_000_000 },
    };
    await ctx
      .http()
      .post('/api/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(JSON.stringify(tampered))
      .expect(401);

    expect((await paymentRow(started.body.paymentId)).status).toBe('PENDING');
  });

  it('acts on a replayed event exactly once', async () => {
    const started = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);
    const event = chargeSuccess(started.body.reference);

    const first = await webhook(event).expect(200);
    const second = await webhook(event).expect(200);

    expect(first.body.status).toBe('verified');
    expect(second.body.status).toBe('duplicate');

    // One payment, one receipt, one balance movement.
    expect(
      await ctx.db.payment.count({ where: { studentFeeId: invoiceId } }),
    ).toBe(1);
    expect((await invoiceRow()).amountPaid.toNumber()).toBe(50000);

    // Two guards stand behind that, and each holds on its own: verification is
    // conditional on the payment still being PENDING, and the delivery itself
    // is recorded so a retry never reaches the verification at all.
    expect(await ctx.db.webhookEvent.count()).toBe(1);
  });

  it('lets a delivery be retried when the first attempt broke halfway', async () => {
    const started = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);
    const event = chargeSuccess(started.body.reference);

    // The database goes away mid-verification: Paystack's retry is the only
    // thing that will settle this payment, so the record of the delivery must
    // not outlive the failure.
    const payments = ctx.app.get(PaymentsService);
    const failOnce = jest
      .spyOn(payments, 'verify')
      .mockRejectedValueOnce(new Error('connection lost'));

    await webhook(event).expect(500);
    expect((await paymentRow(started.body.paymentId)).status).toBe('PENDING');
    expect(await ctx.db.webhookEvent.count()).toBe(0);

    const retry = await webhook(event).expect(200);
    expect(retry.body.status).toBe('verified');
    expect((await invoiceRow()).amountPaid.toNumber()).toBe(50000);

    failOnce.mockRestore();
  });

  it('will not settle a payment for a different amount than was asked for', async () => {
    const started = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);

    const response = await webhook(
      chargeSuccess(started.body.reference, { amount: 100 }),
    ).expect(200);

    expect(response.body.status).toBe('mismatch');
    // Left for a person to decide about, not silently accepted or discarded.
    expect((await paymentRow(started.body.paymentId)).status).toBe('PENDING');
    expect((await invoiceRow()).amountPaid.toNumber()).toBe(0);
    expect(
      await ctx.db.auditLog.count({
        where: { action: 'payment.online_mismatch' },
      }),
    ).toBe(1);
  });

  it('will not settle a payment made in another currency', async () => {
    const started = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);

    const response = await webhook(
      chargeSuccess(started.body.reference, { currency: 'USD' }),
    ).expect(200);

    expect(response.body.status).toBe('mismatch');
    expect((await paymentRow(started.body.paymentId)).status).toBe('PENDING');
  });

  it('acknowledges a reference it never issued without touching anything', async () => {
    const response = await webhook(chargeSuccess('EDU-not-ours')).expect(200);
    expect(response.body.status).toBe('unknown-reference');
  });

  it.each([
    ['a failed charge', { status: 'failed' }],
    ['an event we do not act on', { event: 'transfer.success' }],
  ])('ignores %s', async (_label, overrides) => {
    const started = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);

    const event = chargeSuccess(started.body.reference);
    const payload =
      'event' in overrides
        ? { ...event, ...overrides }
        : { ...event, data: { ...event.data, ...overrides } };

    const response = await webhook(payload).expect(200);
    expect(response.body.status).toBe('ignored');
    expect((await paymentRow(started.body.paymentId)).status).toBe('PENDING');
  });

  it('ignores a payload in a shape it does not recognise', async () => {
    const response = await webhook({ hello: 'world' }).expect(200);
    expect(response.body.status).toBe('ignored');
  });

  it('settles into the right school when two schools are live at once', async () => {
    // A payment in each school, settled by its own webhook.
    const mine = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);

    const theirs = await otherSchoolInvoice();
    const theirPayment = await ctx
      .http()
      .post('/api/finance/payments/online')
      .set(bearer(other.accessToken))
      .send({ studentFeeId: theirs, amount: 20000 })
      .expect(201);

    await webhook(
      chargeSuccess(theirPayment.body.reference, { amount: 2_000_000 }),
    ).expect(200);

    // Theirs moved; mine did not.
    expect((await paymentRow(theirPayment.body.paymentId)).status).toBe(
      'VERIFIED',
    );
    expect((await paymentRow(mine.body.paymentId)).status).toBe('PENDING');

    const settled = await ctx.db.payment.findUniqueOrThrow({
      where: { id: theirPayment.body.paymentId },
    });
    expect(settled.schoolId).toBe(other.schoolId);
  });

  // -------------------------------------------------------------------------
  // The parent portal
  // -------------------------------------------------------------------------

  describe('from the parent portal', () => {
    let parentToken: string;
    let parentEmail: string;

    beforeEach(async () => {
      // A fresh address each time: guardians outlive the students they were
      // attached to, and their email is unique within a school.
      parentEmail = `emeka-${Date.now()}@family.test`;
      parentToken = await linkParentTo(studentId, parentEmail);
    });

    it('lets a parent pay their own child\u2019s invoice', async () => {
      const response = await ctx
        .http()
        .post(`/api/portal/children/${studentId}/payments/online`)
        .set(bearer(parentToken))
        .send({ studentFeeId: invoiceId, amount: 50000 })
        .expect(201);

      expect(response.body.authorizationUrl).toContain('checkout.paystack.com');
      // Paystack sends its own receipt to the guardian on file.
      expect(paystack.initializeCalls[0].email).toBe(parentEmail);

      await webhook(chargeSuccess(response.body.reference)).expect(200);
      expect((await invoiceRow()).status).toBe('PAID');
    });

    it('answers 404 for another family\u2019s child in the same school', async () => {
      // A second family, with their own child and their own invoice — so the
      // ward check is the only thing in the way, not a mismatched invoice.
      const theirs = await siblingWithOwnInvoice('Chidi', 'Eze');

      // The tenant guard cannot help here: both children are in this school.
      await ctx
        .http()
        .post(`/api/portal/children/${theirs.studentId}/payments/online`)
        .set(bearer(parentToken))
        .send({ studentFeeId: theirs.invoiceId, amount: 1000 })
        .expect(404);

      expect(paystack.initializeCalls).toHaveLength(0);
    });

    it('refuses an invoice that is not the named child\u2019s', async () => {
      const sibling = await siblingWithOwnInvoice('Bola', 'Ade');
      await ctx
        .http()
        .post(`/api/students/${sibling.studentId}/guardians`)
        .set(auth())
        .send({ guardianId, relationship: 'FATHER' })
        .expect(201);

      // Both children are theirs, but the pair in the request has to agree:
      // one child's id with the other child's invoice pays nobody.
      await ctx
        .http()
        .post(`/api/portal/children/${sibling.studentId}/payments/online`)
        .set(bearer(parentToken))
        .send({ studentFeeId: invoiceId, amount: 1000 })
        .expect(404);
    });

    it('keeps staff out of the portal route', async () => {
      await ctx
        .http()
        .post(`/api/portal/children/${studentId}/payments/online`)
        .set(auth())
        .send({ studentFeeId: invoiceId, amount: 1000 })
        .expect(403);
    });

    it('lets a parent check a payment that has not settled yet', async () => {
      const started = await ctx
        .http()
        .post(`/api/portal/children/${studentId}/payments/online`)
        .set(bearer(parentToken))
        .send({ studentFeeId: invoiceId, amount: 50000 })
        .expect(201);

      const response = await ctx
        .http()
        .post(
          `/api/portal/children/${studentId}/payments/${started.body.paymentId}/refresh`,
        )
        .set(bearer(parentToken))
        .expect(200);

      expect(response.body).toEqual({ status: 'PENDING' });
    });
  });

  // -------------------------------------------------------------------------
  // The fallback when no webhook arrives
  // -------------------------------------------------------------------------

  it('settles from a refresh when the webhook never came', async () => {
    const started = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);

    paystack.onVerify = () =>
      Promise.resolve({
        status: 'success',
        amountKobo: 5_000_000,
        currency: 'NGN',
        paidAt: new Date('2025-10-02T09:00:00.000Z'),
        channel: 'card',
      });

    const response = await ctx
      .http()
      .post(`/api/finance/payments/online/${started.body.paymentId}/refresh`)
      .set(auth())
      .expect(200);

    expect(response.body).toEqual({ status: 'VERIFIED' });
    expect((await invoiceRow()).amountPaid.toNumber()).toBe(50000);
  });

  it('leaves a payment pending when the provider says it was not paid', async () => {
    const started = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);

    const response = await ctx
      .http()
      .post(`/api/finance/payments/online/${started.body.paymentId}/refresh`)
      .set(auth())
      .expect(200);

    expect(response.body).toEqual({ status: 'PENDING' });
    expect((await invoiceRow()).amountPaid.toNumber()).toBe(0);
  });

  it('will not settle from a refresh reporting a different amount', async () => {
    const started = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);

    paystack.onVerify = () =>
      Promise.resolve({
        status: 'success',
        amountKobo: 100,
        currency: 'NGN',
        paidAt: null,
        channel: 'card',
      });

    const response = await ctx
      .http()
      .post(`/api/finance/payments/online/${started.body.paymentId}/refresh`)
      .set(auth())
      .expect(200);

    expect(response.body).toEqual({ status: 'PENDING' });
  });

  it('refuses to refresh a payment that was never started online', async () => {
    const cash = await ctx
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

    await ctx
      .http()
      .post(`/api/finance/payments/online/${cash.body.id}/refresh`)
      .set(auth())
      .expect(409);
  });

  it('cannot refresh another school’s payment', async () => {
    const started = await startOnline({
      studentFeeId: invoiceId,
      amount: 50000,
    }).expect(201);

    await ctx
      .http()
      .post(`/api/finance/payments/online/${started.body.paymentId}/refresh`)
      .set(bearer(other.accessToken))
      .expect(404);
  });

  // -------------------------------------------------------------------------

  /** Creates a guardian for the student, invites them, and logs them in. */
  async function linkParentTo(student: string, email: string): Promise<string> {
    const created = await ctx
      .http()
      .post('/api/guardians')
      .set(auth())
      .send({
        firstName: 'Emeka',
        lastName: 'Parent',
        phone: '08031234567',
        email,
      })
      .expect(201);
    guardianId = created.body.id;

    await ctx
      .http()
      .post(`/api/students/${student}/guardians`)
      .set(auth())
      .send({ guardianId, relationship: 'FATHER', isPrimary: true })
      .expect(201);

    await ctx
      .http()
      .post(`/api/guardians/${guardianId}/portal-access`)
      .set(auth())
      .expect(201);

    const invitation = invitations[invitations.length - 1];
    await ctx
      .http()
      .post('/api/users/accept-invitation')
      .send({ token: invitation.token, password: 'ParentPass123' })
      .expect(200);

    const login = await ctx
      .http()
      .post('/api/auth/login')
      .send({ email: invitation.to, password: 'ParentPass123' })
      .expect(200);
    return login.body.tokens.accessToken;
  }

  /** Another child in the same arm, invoiced from the same structure. */
  async function siblingWithOwnInvoice(
    firstName: string,
    lastName: string,
  ): Promise<{ studentId: string; invoiceId: string }> {
    const student = await ctx
      .http()
      .post('/api/students')
      .set(auth())
      .send({
        firstName,
        lastName,
        gender: 'MALE',
        admissionDate: '2025-09-15',
        classArmId: armId,
      })
      .expect(201);

    // Re-running the assignment skips the students already invoiced.
    const assigned = await ctx
      .http()
      .post('/api/finance/invoices/assign')
      .set(auth())
      .send({ structureId, classArmId: armId })
      .expect(201);

    return {
      studentId: student.body.id,
      invoiceId: assigned.body.invoices[0].id,
    };
  }

  async function loginAsTeacher(): Promise<string> {
    const email = 'teacher@paystack.test';
    const existing = await ctx.db.user.findUnique({ where: { email } });
    if (!existing) {
      const role = await ctx.db.role.findFirstOrThrow({
        where: { schoolId: school.schoolId, slug: 'TEACHER' },
      });
      const user = await ctx.db.user.create({
        data: {
          email,
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
    }

    const login = await ctx
      .http()
      .post('/api/auth/login')
      .send({ email, password: 'StrongPass123' })
      .expect(200);
    return login.body.tokens.accessToken;
  }

  /** A published, assigned invoice in the rival school, worth ₦20,000. */
  async function otherSchoolInvoice(): Promise<string> {
    const token = bearer(other.accessToken);

    const session = await ctx
      .http()
      .post('/api/academics/sessions')
      .set(token)
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
      .set(token)
      .send({ name: 'JSS1', level: 1 })
      .expect(201);
    const arm = await ctx
      .http()
      .post('/api/academics/class-arms')
      .set(token)
      .send({ classId: klass.body.id, name: 'A' })
      .expect(201);
    await ctx
      .http()
      .post('/api/students')
      .set(token)
      .send({
        firstName: 'Chidi',
        lastName: 'Eze',
        gender: 'MALE',
        admissionDate: '2025-09-15',
        classArmId: arm.body.id,
      })
      .expect(201);
    const category = await ctx
      .http()
      .post('/api/finance/fee-categories')
      .set(token)
      .send({ name: 'Tuition' })
      .expect(201);
    const structure = await ctx
      .http()
      .post('/api/finance/fee-structures')
      .set(token)
      .send({
        name: 'JSS1 First Term',
        sessionId: session.body.id,
        items: [{ categoryId: category.body.id, amount: 20000 }],
      })
      .expect(201);
    await ctx
      .http()
      .post(`/api/finance/fee-structures/${structure.body.id}/publish`)
      .set(token)
      .expect(200);
    const assigned = await ctx
      .http()
      .post('/api/finance/invoices/assign')
      .set(token)
      .send({ structureId: structure.body.id, classArmId: arm.body.id })
      .expect(201);
    return assigned.body.invoices[0].id;
  }
});
