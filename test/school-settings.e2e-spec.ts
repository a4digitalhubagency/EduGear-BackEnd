import { MembershipStatus, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
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
 * Settings are only worth having if they change what the system does, so every
 * test here changes one and then checks the behaviour it governs — and that
 * changing it never rewrites what was already issued.
 */
describe('School settings', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let teacherToken: string;
  const year = new Date().getUTCFullYear();

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const head = () => bearer(school.accessToken);

  const setSettings = (
    body: Record<string, unknown>,
    token = school.accessToken,
  ) =>
    ctx.http().patch('/api/schools/me/settings').set(bearer(token)).send(body);

  const admit = (firstName: string) =>
    ctx
      .http()
      .post('/api/students')
      .set(head())
      .send({
        firstName,
        lastName: 'Pupil',
        gender: 'FEMALE',
        admissionDate: `${year}-09-15`,
      });

  async function invoiceFor(studentId: string, structureId: string) {
    const result = await ctx
      .http()
      .post('/api/finance/invoices/assign')
      .set(head())
      .send({ structureId, studentIds: [studentId] })
      .expect(201);
    return result.body.invoices[0];
  }

  async function feeStructure(dueDate?: string) {
    const session = await ctx.db.academicSession.findFirstOrThrow({
      where: { schoolId: school.schoolId },
    });
    const category = await ctx
      .http()
      .post('/api/finance/fee-categories')
      .set(head())
      .send({ name: `Tuition ${Math.random().toString(36).slice(2, 7)}` })
      .expect(201);
    const structure = await ctx
      .http()
      .post('/api/finance/fee-structures')
      .set(head())
      .send({
        name: `Fees ${Math.random().toString(36).slice(2, 7)}`,
        sessionId: session.id,
        items: [{ categoryId: category.body.id, amount: 50000 }],
        ...(dueDate ? { dueDate } : {}),
      })
      .expect(201);
    await ctx
      .http()
      .post(`/api/finance/fee-structures/${structure.body.id}/publish`)
      .set(head())
      .expect(200);
    return structure.body.id as string;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Settings College' });
    other = await registerSchool(ctx, { schoolName: 'Rival Academy' });

    const role = await ctx.db.role.findFirstOrThrow({
      where: { schoolId: school.schoolId, slug: 'TEACHER' },
    });
    const user = await ctx.db.user.create({
      data: {
        email: 'teacher@settings.test',
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
      .send({ email: 'teacher@settings.test', password: 'StrongPass123' })
      .expect(200);
    teacherToken = login.body.tokens.accessToken;

    jest
      .spyOn(ctx.app.get(EmailService), 'sendParentInvitation')
      .mockImplementation(() => Promise.resolve());
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    for (const table of [
      'notification',
      'feeReminder',
      'payment',
      'studentFeeItem',
      'studentFee',
      'feeStructureItem',
      'feeStructure',
      'feeCategory',
      'studentGuardian',
      'guardian',
      'subjectResult',
      'studentResult',
      'resultSheet',
      'score',
      'teachingAssignment',
      'classSubject',
      'subject',
      'assessmentComponent',
      'gradeBand',
      'student',
      'classArm',
      'class',
      'term',
      'academicSession',
      'schoolSettings',
    ] as const) {
      await (
        ctx.db[table] as { deleteMany: (a: object) => Promise<unknown> }
      ).deleteMany({});
    }
    await ctx
      .http()
      .post('/api/academics/sessions')
      .set(head())
      .send({
        name: `${year}/${year + 1}`,
        startDate: `${year}-09-15`,
        endDate: `${year + 1}-07-24`,
        isCurrent: true,
      })
      .expect(201);
  });

  it('reports the defaults for a school that has changed nothing', async () => {
    const response = await ctx
      .http()
      .get('/api/schools/me/settings')
      .set(head())
      .expect(200);
    expect(response.body).toEqual({
      admissionNumberPrefix: null,
      admissionNumberExample: `${year}/0001`,
      receiptPrefix: 'RCP',
      portalEnabled: true,
      reminderCooldownDays: 7,
      invoiceDueDays: null,
      reportShowPosition: true,
      reportShowClassStats: true,
    });
    // Reading never writes a row.
    expect(await ctx.db.schoolSettings.count()).toBe(0);
  });

  describe('admission numbers', () => {
    it('prefixes new numbers and continues the sequence when the prefix changes', async () => {
      const first = await admit('Ada').expect(201);
      expect(first.body.studentId).toBe(`${year}/0001`);

      const updated = await setSettings({
        admissionNumberPrefix: 'bsc',
      }).expect(200);
      expect(updated.body).toMatchObject({
        admissionNumberPrefix: 'BSC',
        admissionNumberExample: `BSC/${year}/0001`,
      });

      const second = await admit('Bola').expect(201);
      // Prefixed, and the sequence carries on rather than restarting.
      expect(second.body.studentId).toBe(`BSC/${year}/0002`);

      // The number already issued is untouched.
      const ada = await ctx
        .http()
        .get(`/api/students/${first.body.id}`)
        .set(head())
        .expect(200);
      expect(ada.body.studentId).toBe(`${year}/0001`);
    });

    it('applies the prefix to imported students too', async () => {
      await setSettings({ admissionNumberPrefix: 'BSC' }).expect(200);
      const imported = await ctx
        .http()
        .post('/api/students/import')
        .set(head())
        .send({
          rows: [
            {
              firstName: 'Chidi',
              lastName: 'Pupil',
              gender: 'M',
              admissionDate: `15/09/${year}`,
            },
          ],
        })
        .expect(200);
      expect(imported.body.rows[0].admissionNumber).toBe(`BSC/${year}/0001`);
    });

    it('refuses a prefix that is not a code', async () => {
      await setSettings({ admissionNumberPrefix: 'B C' }).expect(400);
      await setSettings({
        admissionNumberPrefix: 'WAY-TOO-LONG-PREFIX',
      }).expect(400);
      await setSettings({ admissionNumberPrefix: null }).expect(200);
    });
  });

  describe('receipts', () => {
    it('prefixes receipts and continues their sequence across a change', async () => {
      const student = await admit('Ada').expect(201);
      const structureId = await feeStructure();
      const invoice = await invoiceFor(student.body.id, structureId);

      const pay = async (amount: number) => {
        const payment = await ctx
          .http()
          .post('/api/finance/payments')
          .set(head())
          .send({
            studentFeeId: invoice.id,
            amount,
            method: 'CASH',
            paidAt: `${year}-10-01T10:00:00Z`,
          })
          .expect(201);
        const verified = await ctx
          .http()
          .post(`/api/finance/payments/${payment.body.id}/verify`)
          .set(head())
          .expect(200);
        return verified.body.receiptNumber as string;
      };

      expect(await pay(1000)).toBe(`RCP/${year}/000001`);
      await setSettings({ receiptPrefix: 'BSC' }).expect(200);
      expect(await pay(1000)).toBe(`BSC/${year}/000002`);
    });
  });

  describe('invoice due dates', () => {
    it('falls back to the school’s default, and never overrides a real one', async () => {
      const student = await admit('Ada').expect(201);
      await setSettings({ invoiceDueDays: 14 }).expect(200);

      const withDefault = await invoiceFor(
        student.body.id,
        await feeStructure(),
      );
      const expected = new Date();
      expected.setUTCDate(expected.getUTCDate() + 14);
      expect(withDefault.dueDate.slice(0, 10)).toBe(
        expected.toISOString().slice(0, 10),
      );

      // A structure that names its own date keeps it.
      const dated = await invoiceFor(
        student.body.id,
        await feeStructure(`${year}-12-01`),
      );
      expect(dated.dueDate.slice(0, 10)).toBe(`${year}-12-01`);
    });

    it('leaves invoices undated when the school sets no default', async () => {
      const student = await admit('Ada').expect(201);
      const invoice = await invoiceFor(student.body.id, await feeStructure());
      expect(invoice.dueDate).toBeNull();
    });
  });

  describe('the parent portal switch', () => {
    async function parentToken(): Promise<string> {
      const student = await admit('Ada').expect(201);
      const guardian = await ctx
        .http()
        .post('/api/guardians')
        .set(head())
        .send({
          firstName: 'Emeka',
          lastName: 'Parent',
          phone: '08031234567',
          email: 'emeka@settings.test',
        })
        .expect(201);
      await ctx
        .http()
        .post(`/api/students/${student.body.id}/guardians`)
        .set(head())
        .send({ guardianId: guardian.body.id, relationship: 'FATHER' })
        .expect(201);
      await ctx
        .http()
        .post(`/api/guardians/${guardian.body.id}/portal-access`)
        .set(head())
        .expect(201);

      // The invitation's raw token is only ever emailed, so the parent is
      // activated directly here; acceptance itself is covered in portal.e2e.
      const user = await ctx.db.user.findFirstOrThrow({
        where: { email: 'emeka@settings.test' },
      });
      await ctx.db.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await argon2.hash('ParentPass123', {
            type: argon2.argon2id,
          }),
          status: UserStatus.ACTIVE,
          emailVerifiedAt: new Date(),
        },
      });
      await ctx.db.membership.updateMany({
        where: { userId: user.id },
        data: { status: MembershipStatus.ACTIVE, acceptedAt: new Date() },
      });
      const login = await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: 'emeka@settings.test', password: 'ParentPass123' })
        .expect(200);
      return login.body.tokens.accessToken;
    }

    it('closes the portal to parents without touching staff or logins', async () => {
      const token = await parentToken();
      await ctx.http().get('/api/portal/me').set(bearer(token)).expect(200);

      await setSettings({ portalEnabled: false }).expect(200);

      const closed = await ctx
        .http()
        .get('/api/portal/me')
        .set(bearer(token))
        .expect(403);
      expect(closed.body.message).toMatch(/switched off by the school/);
      // Staff carry on as normal.
      await ctx.http().get('/api/students').set(head()).expect(200);

      await setSettings({ portalEnabled: true }).expect(200);
      await ctx.http().get('/api/portal/me').set(bearer(token)).expect(200);
    });

    it('will not invite a parent while the portal is closed', async () => {
      await setSettings({ portalEnabled: false }).expect(200);
      const guardian = await ctx
        .http()
        .post('/api/guardians')
        .set(head())
        .send({
          firstName: 'Ngozi',
          lastName: 'Parent',
          phone: '08099998888',
          email: 'ngozi@settings.test',
        })
        .expect(201);
      await ctx
        .http()
        .post(`/api/guardians/${guardian.body.id}/portal-access`)
        .set(head())
        .expect(403);
    });
  });

  describe('report cards', () => {
    it('hides positions and class figures when the school asks', async () => {
      // Built through the normal results path.
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
      const session = await ctx.db.academicSession.findFirstOrThrow({
        where: { schoolId: school.schoolId },
      });
      const term = await ctx
        .http()
        .post('/api/academics/terms')
        .set(head())
        .send({
          sessionId: session.id,
          name: 'FIRST',
          startDate: `${year}-09-15`,
          endDate: `${year}-12-19`,
          isCurrent: true,
        })
        .expect(201);
      const klass = await ctx
        .http()
        .post('/api/academics/classes')
        .set(head())
        .send({ name: 'JSS1', level: 1 })
        .expect(201);
      const arm = await ctx
        .http()
        .post('/api/academics/class-arms')
        .set(head())
        .send({ classId: klass.body.id, name: 'A' })
        .expect(201);
      const subject = await ctx
        .http()
        .post('/api/results/subjects')
        .set(head())
        .send({ name: 'Mathematics', code: 'MTH' })
        .expect(201);
      await ctx
        .http()
        .post(`/api/results/classes/${klass.body.id}/subjects`)
        .set(head())
        .send({ subjectId: subject.body.id })
        .expect(201);

      const student = await admit('Ada').expect(201);
      await ctx
        .http()
        .patch(`/api/students/${student.body.id}`)
        .set(head())
        .send({ classArmId: arm.body.id })
        .expect(200);

      await ctx
        .http()
        .put('/api/results/scores')
        .set(head())
        .send({
          classArmId: arm.body.id,
          subjectId: subject.body.id,
          termId: term.body.id,
          entries: scheme.body.components.map(
            (c: { id: string; maxScore: number }) => ({
              studentId: student.body.id,
              componentId: c.id,
              score: c.maxScore,
            }),
          ),
        })
        .expect(200);
      await ctx
        .http()
        .post('/api/results/sheets/compute')
        .set(head())
        .send({ classArmId: arm.body.id, termId: term.body.id })
        .expect(200);

      const shown = await ctx
        .http()
        .get(
          `/api/results/report-cards/${student.body.id}?termId=${term.body.id}`,
        )
        .set(head())
        .expect(200);
      expect(shown.body.positionLabel).toBe('1st');
      expect(shown.body.subjects[0].classHighest).toBe(100);

      await setSettings({
        reportShowPosition: false,
        reportShowClassStats: false,
      }).expect(200);

      const hidden = await ctx
        .http()
        .get(
          `/api/results/report-cards/${student.body.id}?termId=${term.body.id}`,
        )
        .set(head())
        .expect(200);
      expect(hidden.body.position).toBeNull();
      expect(hidden.body.positionLabel).toBeNull();
      expect(hidden.body.subjects[0].position).toBeNull();
      expect(hidden.body.subjects[0].classHighest).toBeNull();
      // The marks themselves are still there.
      expect(hidden.body.subjects[0].total).toBe(100);
    });
  });

  describe('permissions, isolation and the trail', () => {
    it('lets staff read settings but only school.update change them', async () => {
      await ctx
        .http()
        .get('/api/schools/me/settings')
        .set(bearer(teacherToken))
        .expect(200);
      await setSettings({ portalEnabled: false }, teacherToken).expect(403);
    });

    it('rejects values outside their range', async () => {
      await setSettings({ reminderCooldownDays: 91 }).expect(400);
      await setSettings({ invoiceDueDays: 400 }).expect(400);
      await setSettings({ reminderCooldownDays: 0 }).expect(200);
    });

    it('keeps each school’s settings to itself', async () => {
      await setSettings({ admissionNumberPrefix: 'BSC' }).expect(200);
      const theirs = await ctx
        .http()
        .get('/api/schools/me/settings')
        .set(bearer(other.accessToken))
        .expect(200);
      expect(theirs.body.admissionNumberPrefix).toBeNull();
    });

    it('records what changed', async () => {
      await setSettings({
        portalEnabled: false,
        reminderCooldownDays: 14,
      }).expect(200);
      const entry = await ctx.db.auditLog.findFirst({
        where: { schoolId: school.schoolId, action: 'school.settings.updated' },
        orderBy: { createdAt: 'desc' },
      });
      expect(entry?.metadata).toMatchObject({
        changed: ['portalEnabled', 'reminderCooldownDays'],
      });
    });

    it('writes nothing when a change is a no-op', async () => {
      const before = await ctx.db.auditLog.count({
        where: { schoolId: school.schoolId, action: 'school.settings.updated' },
      });
      await setSettings({ portalEnabled: true }).expect(200);
      expect(
        await ctx.db.auditLog.count({
          where: {
            schoolId: school.schoolId,
            action: 'school.settings.updated',
          },
        }),
      ).toBe(before);
    });
  });
});
