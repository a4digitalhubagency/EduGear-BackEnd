import { EmailService } from '../src/notifications/email.service';
import {
  closeTestApp,
  createTestApp,
  registerSchool,
  RegisteredSchool,
  resetDatabase,
  TestContext,
} from './utils/test-app';

/**
 * The parent portal. The property that matters most is intra-school
 * isolation: a parent sees their own children and nobody else's, even inside
 * the same school — the tenant guard alone cannot enforce that.
 */
describe('Parent portal', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let invitations: { to: string; token: string; children: string[] }[];

  let termId: string;
  let armId: string;
  let structureId: string;
  let ada: string;
  let bola: string;
  let chidi: string;
  let emeka: string; // Ada and Bola's father
  let ngozi: string; // Chidi's mother

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const head = () => bearer(school.accessToken);

  async function guardian(
    firstName: string,
    email: string | null,
    phone: string,
  ) {
    return (
      await ctx
        .http()
        .post('/api/guardians')
        .set(head())
        .send({
          firstName,
          lastName: 'Parent',
          phone,
          ...(email ? { email } : {}),
        })
        .expect(201)
    ).body.id as string;
  }

  /** Invites a guardian, accepts the emailed link, and logs in. */
  async function parentLogin(
    guardianId: string,
    password = 'ParentPass123',
  ): Promise<string> {
    await ctx
      .http()
      .post(`/api/guardians/${guardianId}/portal-access`)
      .set(head())
      .expect(201);
    const invitation = invitations[invitations.length - 1];
    await ctx
      .http()
      .post('/api/users/accept-invitation')
      .send({ token: invitation.token, password })
      .expect(200);
    const login = await ctx
      .http()
      .post('/api/auth/login')
      .send({ email: invitation.to, password })
      .expect(200);
    return login.body.tokens.accessToken;
  }

  async function invoiceOf(studentId: string): Promise<string> {
    const list = await ctx
      .http()
      .get(`/api/finance/invoices?studentId=${studentId}`)
      .set(head())
      .expect(200);
    return list.body.data[0].id;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Portal College' });

    // Capture invitation links instead of reading them from a mailbox.
    const email = ctx.app.get(EmailService);
    jest.spyOn(email, 'sendParentInvitation').mockImplementation((params) => {
      invitations.push({
        to: params.to,
        token: params.token,
        children: params.children,
      });
      return Promise.resolve();
    });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    invitations = [];
    for (const table of [
      'notification',
      'attendanceRecord',
      'subjectResult',
      'studentResult',
      'resultSheet',
      'score',
      'teachingAssignment',
      'classSubject',
      'subject',
      'assessmentComponent',
      'gradeBand',
      'feeReminder',
      'payment',
      'studentFeeItem',
      'studentFee',
      'feeStructureItem',
      'feeStructure',
      'feeCategory',
      'studentGuardian',
      'guardian',
      'student',
      'classArm',
      'class',
      'term',
      'academicSession',
    ] as const) {
      await (
        ctx.db[table] as { deleteMany: (a: object) => Promise<unknown> }
      ).deleteMany({});
    }
    // Parent logins from earlier tests.
    await ctx.db.membership.deleteMany({
      where: { schoolId: school.schoolId, role: { slug: 'PARENT' } },
    });
    await ctx.db.user.deleteMany({
      where: { email: { endsWith: '@family.test' } },
    });

    const session = await ctx
      .http()
      .post('/api/academics/sessions')
      .set(head())
      .send({
        name: '2025/2026',
        startDate: '2025-09-15',
        endDate: '2026-07-24',
        isCurrent: true,
      })
      .expect(201);
    termId = (
      await ctx
        .http()
        .post('/api/academics/terms')
        .set(head())
        .send({
          sessionId: session.body.id,
          name: 'FIRST',
          startDate: '2025-09-15',
          endDate: '2025-12-19',
          isCurrent: true,
        })
        .expect(201)
    ).body.id;
    const classId = (
      await ctx
        .http()
        .post('/api/academics/classes')
        .set(head())
        .send({ name: 'JSS1', level: 1 })
        .expect(201)
    ).body.id;
    armId = (
      await ctx
        .http()
        .post('/api/academics/class-arms')
        .set(head())
        .send({ classId, name: 'A' })
        .expect(201)
    ).body.id;

    const imported = await ctx
      .http()
      .post('/api/students/import')
      .set(head())
      .send({
        rows: [
          ['Ada', 'Okafor'],
          ['Bola', 'Okafor'],
          ['Chidi', 'Eze'],
        ].map(([firstName, lastName]) => ({
          firstName,
          lastName,
          gender: 'F',
          admissionDate: '2025-09-15',
          classArmId: armId,
        })),
      })
      .expect(200);
    [ada, bola, chidi] = imported.body.rows.map(
      (row: { studentId: string }) => row.studentId,
    );

    emeka = await guardian('Emeka', 'emeka@family.test', '08031234567');
    ngozi = await guardian('Ngozi', 'ngozi@family.test', '08099998888');
    for (const [studentId, guardianId] of [
      [ada, emeka],
      [bola, emeka],
      [chidi, ngozi],
    ]) {
      await ctx
        .http()
        .post(`/api/students/${studentId}/guardians`)
        .set(head())
        .send({ guardianId, relationship: 'FATHER', isPrimary: true })
        .expect(201);
    }

    const category = await ctx
      .http()
      .post('/api/finance/fee-categories')
      .set(head())
      .send({ name: 'Tuition' })
      .expect(201);
    structureId = (
      await ctx
        .http()
        .post('/api/finance/fee-structures')
        .set(head())
        .send({
          name: 'First Term',
          sessionId: session.body.id,
          items: [{ categoryId: category.body.id, amount: 50000 }],
        })
        .expect(201)
    ).body.id;
    await ctx
      .http()
      .post(`/api/finance/fee-structures/${structureId}/publish`)
      .set(head())
      .expect(200);
  });

  // -------------------------------------------------------------------------
  // Getting a login
  // -------------------------------------------------------------------------

  describe('access', () => {
    it('invites a parent, naming their children in the email', async () => {
      const response = await ctx
        .http()
        .post(`/api/guardians/${emeka}/portal-access`)
        .set(head())
        .expect(201);
      expect(response.body).toMatchObject({
        status: 'INVITED',
        email: 'emeka@family.test',
      });
      expect(invitations[0].children.sort()).toEqual(['Ada', 'Bola']);

      // Invited is not yet access.
      const guardianRow = await ctx
        .http()
        .get(`/api/guardians/${emeka}`)
        .set(head())
        .expect(200);
      expect(guardianRow.body).toMatchObject({
        portalStatus: 'INVITED',
        hasPortalAccess: false,
      });
    });

    it('refuses a parent with no email on file', async () => {
      const noEmail = await guardian('Uche', null, '08055556666');
      await ctx
        .http()
        .post(`/api/students/${chidi}/guardians`)
        .set(head())
        .send({ guardianId: noEmail, relationship: 'UNCLE' })
        .expect(201);
      const response = await ctx
        .http()
        .post(`/api/guardians/${noEmail}/portal-access`)
        .set(head())
        .expect(409);
      expect(response.body.message).toMatch(/no email address/);
    });

    it('activates on acceptance and shows the parent only their own children', async () => {
      const token = await parentLogin(emeka);

      const me = await ctx
        .http()
        .get('/api/portal/me')
        .set(bearer(token))
        .expect(200);
      expect(me.body).toMatchObject({
        fullName: 'Emeka Parent',
        schoolName: 'Portal College',
      });
      expect(
        me.body.children.map((c: { fullName: string }) => c.fullName).sort(),
      ).toEqual(['Okafor, Ada', 'Okafor, Bola']);

      const guardianRow = await ctx
        .http()
        .get(`/api/guardians/${emeka}`)
        .set(head())
        .expect(200);
      expect(guardianRow.body).toMatchObject({
        portalStatus: 'ACTIVE',
        hasPortalAccess: true,
      });
    });

    it('retires the earlier link when an invitation is re-sent', async () => {
      await ctx
        .http()
        .post(`/api/guardians/${emeka}/portal-access`)
        .set(head())
        .expect(201);
      const first = invitations[0].token;
      await ctx
        .http()
        .post(`/api/guardians/${emeka}/portal-access`)
        .set(head())
        .expect(201);
      const second = invitations[1].token;

      await ctx
        .http()
        .post('/api/users/accept-invitation')
        .send({ token: first, password: 'ParentPass123' })
        .expect(400);
      await ctx
        .http()
        .post('/api/users/accept-invitation')
        .send({ token: second, password: 'ParentPass123' })
        .expect(200);
    });

    it('keeps staff out of the portal and parents out of staff screens', async () => {
      const token = await parentLogin(emeka);

      await ctx.http().get('/api/portal/me').set(head()).expect(403);
      await ctx.http().get('/api/students').set(bearer(token)).expect(403);
      await ctx
        .http()
        .get('/api/finance/invoices')
        .set(bearer(token))
        .expect(403);
    });

    it('cuts a revoked parent off on their very next request', async () => {
      const token = await parentLogin(emeka);
      await ctx
        .http()
        .get('/api/portal/children')
        .set(bearer(token))
        .expect(200);

      const revoked = await ctx
        .http()
        .delete(`/api/guardians/${emeka}/portal-access`)
        .set(head())
        .expect(200);
      expect(revoked.body.status).toBe('NONE');

      const response = await ctx
        .http()
        .get('/api/portal/children')
        .set(bearer(token))
        .expect(403);
      expect(response.body.errorCode).toBe('MEMBERSHIP_INACTIVE');
    });
  });

  // -------------------------------------------------------------------------
  // Another family's child
  // -------------------------------------------------------------------------

  describe('isolation between families', () => {
    it('answers 404 for another parent’s child on every route', async () => {
      await ctx
        .http()
        .post('/api/finance/invoices/assign')
        .set(head())
        .send({ structureId, classArmId: armId })
        .expect(201);
      const token = await parentLogin(emeka);
      const chidiInvoice = await invoiceOf(chidi);

      for (const path of [
        `/api/portal/children/${chidi}`,
        `/api/portal/children/${chidi}/fees`,
        `/api/portal/children/${chidi}/results`,
        `/api/portal/children/${chidi}/results/${termId}`,
        `/api/portal/children/${chidi}/attendance`,
      ]) {
        await ctx.http().get(path).set(bearer(token)).expect(404);
      }

      await ctx
        .http()
        .post(`/api/portal/children/${chidi}/payments`)
        .set(bearer(token))
        .send({
          studentFeeId: chidiInvoice,
          amount: 1000,
          method: 'BANK_TRANSFER',
          reference: 'X',
          paidAt: '2025-10-01T10:00:00Z',
        })
        .expect(404);
    });

    it('refuses to pay one child’s invoice through a sibling’s route', async () => {
      await ctx
        .http()
        .post('/api/finance/invoices/assign')
        .set(head())
        .send({ structureId, classArmId: armId })
        .expect(201);
      const token = await parentLogin(emeka);

      await ctx
        .http()
        .post(`/api/portal/children/${ada}/payments`)
        .set(bearer(token))
        .send({
          studentFeeId: await invoiceOf(bola),
          amount: 1000,
          method: 'BANK_TRANSFER',
          reference: 'X',
          paidAt: '2025-10-01T10:00:00Z',
        })
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // Fees and payments
  // -------------------------------------------------------------------------

  describe('fees and payments', () => {
    it('shows balances, takes proof of payment, and hands over the receipt once verified', async () => {
      await ctx
        .http()
        .post('/api/finance/invoices/assign')
        .set(head())
        .send({ structureId, studentIds: [ada] })
        .expect(201);
      const token = await parentLogin(emeka);

      const before = await ctx
        .http()
        .get(`/api/portal/children/${ada}`)
        .set(bearer(token))
        .expect(200);
      expect(before.body).toMatchObject({
        feeBalance: 50000,
        pendingPayments: 0,
      });

      const submitted = await ctx
        .http()
        .post(`/api/portal/children/${ada}/payments`)
        .set(bearer(token))
        .send({
          studentFeeId: await invoiceOf(ada),
          amount: 50000,
          method: 'BANK_TRANSFER',
          reference: 'TRF/2025/88123',
          paidAt: '2025-10-01T10:00:00Z',
        })
        .expect(201);
      expect(submitted.body).toMatchObject({
        status: 'PENDING',
        receiptNumber: null,
      });

      // Proof alone moves nothing.
      const pending = await ctx
        .http()
        .get(`/api/portal/children/${ada}`)
        .set(bearer(token))
        .expect(200);
      expect(pending.body).toMatchObject({
        feeBalance: 50000,
        pendingPayments: 50000,
      });
      await ctx
        .http()
        .get(
          `/api/portal/children/${ada}/payments/${submitted.body.id}/receipt`,
        )
        .set(bearer(token))
        .expect(409);

      await ctx
        .http()
        .post(`/api/finance/payments/${submitted.body.id}/verify`)
        .set(head())
        .expect(200);

      const after = await ctx
        .http()
        .get(`/api/portal/children/${ada}`)
        .set(bearer(token))
        .expect(200);
      expect(after.body).toMatchObject({ feeBalance: 0, pendingPayments: 0 });

      const receipt = await ctx
        .http()
        .get(
          `/api/portal/children/${ada}/payments/${submitted.body.id}/receipt`,
        )
        .set(bearer(token))
        .expect(200);
      expect(receipt.body).toMatchObject({ amount: 50000, balanceAfter: 0 });

      const statement = await ctx
        .http()
        .get(`/api/portal/children/${ada}/fees`)
        .set(bearer(token))
        .expect(200);
      expect(statement.body.closingBalance).toBe(0);
    });

    it('refuses cash, which is paid at the office', async () => {
      await ctx
        .http()
        .post('/api/finance/invoices/assign')
        .set(head())
        .send({ structureId, studentIds: [ada] })
        .expect(201);
      const token = await parentLogin(emeka);
      await ctx
        .http()
        .post(`/api/portal/children/${ada}/payments`)
        .set(bearer(token))
        .send({
          studentFeeId: await invoiceOf(ada),
          amount: 1000,
          method: 'CASH',
          reference: 'X',
          paidAt: '2025-10-01T10:00:00Z',
        })
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // Results and attendance
  // -------------------------------------------------------------------------

  describe('results and attendance', () => {
    async function publishedSheet() {
      await ctx
        .http()
        .post('/api/results/setup-defaults')
        .set(head())
        .expect(200);
      const scheme = await ctx
        .http()
        .get('/api/results/assessment-scheme')
        .set(head())
        .expect(200);
      const classes = await ctx
        .http()
        .get('/api/academics/classes')
        .set(head())
        .expect(200);
      const subjectId = (
        await ctx
          .http()
          .post('/api/results/subjects')
          .set(head())
          .send({ name: 'Mathematics', code: 'MTH' })
          .expect(201)
      ).body.id;
      await ctx
        .http()
        .post(`/api/results/classes/${classes.body.data[0].id}/subjects`)
        .set(head())
        .send({ subjectId })
        .expect(201);

      await ctx
        .http()
        .put('/api/results/scores')
        .set(head())
        .send({
          classArmId: armId,
          subjectId,
          termId,
          entries: [ada, bola, chidi].flatMap((studentId, i) =>
            scheme.body.components.map(
              (c: { id: string; maxScore: number }) => ({
                studentId,
                componentId: c.id,
                score: c.maxScore - i,
              }),
            ),
          ),
        })
        .expect(200);

      const sheet = await ctx
        .http()
        .post('/api/results/sheets/compute')
        .set(head())
        .send({ classArmId: armId, termId })
        .expect(200);
      await ctx
        .http()
        .post(`/api/results/sheets/${sheet.body.id}/submit`)
        .set(head())
        .expect(200);
      await ctx
        .http()
        .post(`/api/results/sheets/${sheet.body.id}/approve`)
        .set(head())
        .expect(200);
      return sheet.body.id as string;
    }

    it('hides results until they are published, then shows them', async () => {
      const token = await parentLogin(emeka);
      const sheetId = await publishedSheet(); // approved, not yet published

      await ctx
        .http()
        .get(`/api/portal/children/${ada}/results/${termId}`)
        .set(bearer(token))
        .expect(404);
      expect(
        (
          await ctx
            .http()
            .get(`/api/portal/children/${ada}/results`)
            .set(bearer(token))
            .expect(200)
        ).body,
      ).toEqual([]);

      await ctx
        .http()
        .post(`/api/results/sheets/${sheetId}/publish`)
        .set(head())
        .expect(200);

      const card = await ctx
        .http()
        .get(`/api/portal/children/${ada}/results/${termId}`)
        .set(bearer(token))
        .expect(200);
      expect(card.body).toMatchObject({
        status: 'PUBLISHED',
        positionLabel: '1st',
        outOf: 3,
      });

      const list = await ctx
        .http()
        .get(`/api/portal/children/${ada}/results`)
        .set(bearer(token))
        .expect(200);
      expect(list.body[0]).toMatchObject({
        termName: 'FIRST',
        positionLabel: '1st',
      });

      const me = await ctx
        .http()
        .get('/api/portal/children')
        .set(bearer(token))
        .expect(200);
      const adaRow = me.body.find(
        (c: { studentId: string }) => c.studentId === ada,
      );
      expect(adaRow.latestResult).toMatchObject({ positionLabel: '1st' });
    });

    it('shows attendance, and prints it on the report card', async () => {
      const token = await parentLogin(emeka);
      await ctx
        .http()
        .put('/api/attendance/register')
        .set(head())
        .send({
          classArmId: armId,
          date: '2025-10-06',
          entries: [
            { studentId: ada, status: 'PRESENT' },
            { studentId: bola, status: 'ABSENT' },
          ],
        })
        .expect(200);
      await ctx
        .http()
        .put('/api/attendance/register')
        .set(head())
        .send({
          classArmId: armId,
          date: '2025-10-07',
          entries: [{ studentId: ada, status: 'LATE' }],
        })
        .expect(200);

      const attendance = await ctx
        .http()
        .get(`/api/portal/children/${ada}/attendance`)
        .set(bearer(token))
        .expect(200);
      expect(attendance.body).toMatchObject({
        termName: 'FIRST',
        summary: { daysOpen: 2, present: 2, late: 1 },
      });
      expect(attendance.body.records).toHaveLength(2);

      const sheetId = await publishedSheet();
      await ctx
        .http()
        .post(`/api/results/sheets/${sheetId}/publish`)
        .set(head())
        .expect(200);
      const card = await ctx
        .http()
        .get(`/api/portal/children/${ada}/results/${termId}`)
        .set(bearer(token))
        .expect(200);
      expect(card.body.attendance).toEqual({
        daysOpen: 2,
        present: 2,
        absent: 0,
        late: 1,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  describe('notifications', () => {
    it('tells a parent about invoices, verified payments and published results', async () => {
      const token = await parentLogin(emeka);

      await ctx
        .http()
        .post('/api/finance/invoices/assign')
        .set(head())
        .send({ structureId, studentIds: [ada] })
        .expect(201);
      const payment = await ctx
        .http()
        .post(`/api/portal/children/${ada}/payments`)
        .set(bearer(token))
        .send({
          studentFeeId: await invoiceOf(ada),
          amount: 20000,
          method: 'BANK_TRANSFER',
          reference: 'TRF-1',
          paidAt: '2025-10-01T10:00:00Z',
        })
        .expect(201);
      await ctx
        .http()
        .post(`/api/finance/payments/${payment.body.id}/verify`)
        .set(head())
        .expect(200);

      const inbox = await ctx
        .http()
        .get('/api/portal/notifications')
        .set(bearer(token))
        .expect(200);
      expect(inbox.body.unread).toBe(2);
      expect(inbox.body.data.map((n: { type: string }) => n.type)).toEqual([
        'PAYMENT_VERIFIED',
        'INVOICE_ISSUED',
      ]);
      expect(inbox.body.data[0].body).toMatch(
        /₦20,000.00 for Okafor, Ada has been confirmed/,
      );
    });

    it('does not notify a parent who has no portal login', async () => {
      await ctx
        .http()
        .post('/api/finance/invoices/assign')
        .set(head())
        .send({ structureId, studentIds: [chidi] })
        .expect(201);
      expect(await ctx.db.notification.count()).toBe(0);
    });

    it('marks notifications read, one or all, and only the caller’s own', async () => {
      const emekaToken = await parentLogin(emeka);
      const ngoziToken = await parentLogin(ngozi);
      await ctx
        .http()
        .post('/api/finance/invoices/assign')
        .set(head())
        .send({ structureId, classArmId: armId })
        .expect(201);

      const inbox = await ctx
        .http()
        .get('/api/portal/notifications')
        .set(bearer(emekaToken))
        .expect(200);
      expect(inbox.body.unread).toBe(2);
      const first = inbox.body.data[0].id;

      // Ngozi cannot touch Emeka's notification.
      await ctx
        .http()
        .post(`/api/portal/notifications/${first}/read`)
        .set(bearer(ngoziToken))
        .expect(404);

      const read = await ctx
        .http()
        .post(`/api/portal/notifications/${first}/read`)
        .set(bearer(emekaToken))
        .expect(200);
      expect(read.body.read).toBe(true);

      const all = await ctx
        .http()
        .post('/api/portal/notifications/read-all')
        .set(bearer(emekaToken))
        .expect(200);
      expect(all.body.updated).toBe(1);

      const ngoziInbox = await ctx
        .http()
        .get('/api/portal/notifications?unreadOnly=true')
        .set(bearer(ngoziToken))
        .expect(200);
      expect(ngoziInbox.body.unread).toBe(1);
    });
  });
});
