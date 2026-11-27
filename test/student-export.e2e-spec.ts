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
 * The subject access / portability export — NDP Act s.34(1)(b) and s.38.
 *
 * It is the most concentrated view of a child this application can produce,
 * so the tests care about two things above all: it goes through tenant
 * isolation like everything else, and holding `students.read` alone is not
 * enough to pull fees and results out through it.
 */
describe('Student export', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let readOnlyToken: string;
  let studentId: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const auth = () => bearer(school.accessToken);

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Export College' });
    other = await registerSchool(ctx, { schoolName: 'Rival Academy' });

    // ACCOUNTANT holds finance.read but not results.read — so it holds some
    // of what the export needs and not all of it, which is the interesting
    // case for an AND-ed permission list.
    const role = await ctx.db.role.findFirstOrThrow({
      where: { schoolId: school.schoolId, slug: 'ACCOUNTANT' },
    });
    const user = await ctx.db.user.create({
      data: {
        email: 'bursar@export.test',
        firstName: 'Chidi',
        lastName: 'Bursar',
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
      .send({ email: 'bursar@export.test', password: 'StrongPass123' })
      .expect(200);
    readOnlyToken = login.body.tokens.accessToken;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.db.student.deleteMany({});

    const created = await ctx
      .http()
      .post('/api/students')
      .set(auth())
      .send({
        firstName: 'Ada',
        lastName: 'Obi',
        middleName: 'Ngozi',
        gender: 'FEMALE',
        dateOfBirth: '2012-04-11',
        admissionDate: '2024-09-15',
        email: 'ada@example.test',
        phone: '08030000000',
        addressLine: '14 Awolowo Road',
        sensitiveDataConsent: {
          givenBy: 'Mrs Chinwe Obi',
          method: 'ADMISSION_FORM',
        },
        genotype: 'AS',
        bloodGroup: 'O+',
        religion: 'Christianity',
        stateOfOrigin: 'Anambra',
        lga: 'Onitsha North',
        notes: 'Allergic to peanuts',
      })
      .expect(201);
    studentId = created.body.id;
  });

  const exportRecord = (token = school.accessToken) =>
    ctx.http().get(`/api/students/${studentId}/export`).set(bearer(token));

  // -------------------------------------------------------------------------

  it('returns the whole record in a versioned, machine-readable shape', async () => {
    const response = await exportRecord().expect(200);

    expect(response.body.format).toBe('edugear.student-export.v1');
    expect(response.body.exportedAt).toBeTruthy();
    expect(response.body.school.name).toBe('Export College');

    expect(response.body.student).toMatchObject({
      firstName: 'Ada',
      lastName: 'Obi',
      middleName: 'Ngozi',
      admissionNumber: expect.any(String),
      email: 'ada@example.test',
      addressLine: '14 Awolowo Road',
      notes: 'Allergic to peanuts',
    });

    // Every section is present even when empty, so a consumer can rely on
    // the shape rather than guessing whether a missing key means no data.
    for (const key of [
      'guardians',
      'finance',
      'scores',
      'results',
      'subjectResults',
      'attendance',
    ]) {
      expect(Array.isArray(response.body[key])).toBe(true);
    }
  });

  it('separates the sensitive fields and says what they rest on', async () => {
    // A parent reading their own export should be able to see at a glance
    // which special-category data is held, and that they can have it removed.
    const response = await exportRecord().expect(200);

    expect(response.body.sensitiveData).toMatchObject({
      genotype: 'AS',
      bloodGroup: 'O+',
      religion: 'Christianity',
      stateOfOrigin: 'Anambra',
      lga: 'Onitsha North',
    });
    expect(response.body.sensitiveData.notice).toContain('s.30(1)(a)');
    expect(response.body.sensitiveData.notice).toContain('withdraw');

    // A request under s.34(1)(a) asks what is held *and on what basis*. For
    // these five the basis is one person's act on one day, so the export
    // names it — which is also how a parent spots a consent they never gave.
    expect(response.body.sensitiveData.consent).toMatchObject({
      givenBy: 'Mrs Chinwe Obi',
      method: 'ADMISSION_FORM',
    });
    expect(response.body.sensitiveData.consent.givenAt).toEqual(
      expect.any(String),
    );
    expect(response.body.sensitiveData.consentWithdrawnAt).toBeNull();

    // And they are not duplicated into the main record.
    expect(response.body.student.genotype).toBeUndefined();
  });

  it('cites the sections it is produced under', async () => {
    const response = await exportRecord().expect(200);
    expect(response.body.notice).toContain('34(1)(b)');
    expect(response.body.notice).toContain('38');
  });

  it('downloads as a file named after the admission number', async () => {
    const response = await exportRecord().expect(200);
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['content-disposition']).toContain(
      response.body.student.admissionNumber,
    );
  });

  it('includes guardians with their contact details', async () => {
    const guardian = await ctx
      .http()
      .post('/api/guardians')
      .set(auth())
      .send({
        firstName: 'Chidi',
        lastName: 'Obi',
        phone: '08031111111',
        email: 'chidi@example.test',
        occupation: 'Engineer',
      })
      .expect(201);

    await ctx
      .http()
      .post(`/api/students/${studentId}/guardians`)
      .set(auth())
      .send({
        guardianId: guardian.body.id,
        relationship: 'FATHER',
        isPrimary: true,
      })
      .expect(201);

    const response = await exportRecord().expect(200);
    expect(response.body.guardians).toHaveLength(1);
    expect(response.body.guardians[0]).toMatchObject({
      firstName: 'Chidi',
      relationship: 'FATHER',
      isPrimary: true,
      phone: '08031111111',
      occupation: 'Engineer',
    });
  });

  it('renders money as strings, not floating-point numbers', async () => {
    // Amounts are Decimal in the database. Serialising them as JSON numbers
    // would hand a parent a rounded figure in the one document they are most
    // likely to check against their bank statement.
    const response = await exportRecord().expect(200);
    for (const invoice of response.body.finance) {
      expect(typeof invoice.totalAmount).toBe('string');
      expect(typeof invoice.balance).toBe('string');
    }
  });

  it('reflects an erasure immediately', async () => {
    await ctx
      .http()
      .delete(`/api/students/${studentId}/sensitive-data`)
      .set(auth())
      .expect(200);

    const response = await exportRecord().expect(200);
    expect(response.body.sensitiveData).toMatchObject({
      genotype: null,
      bloodGroup: null,
      religion: null,
      stateOfOrigin: null,
      lga: null,
      // The basis goes with the data. An export still claiming consent for
      // fields it no longer holds would misdescribe the school's position to
      // the one person entitled to an accurate answer.
      consent: null,
    });
    expect(response.body.sensitiveData.consentWithdrawnAt).toEqual(
      expect.any(String),
    );
  });

  // -------------------------------------------------------------------------

  it('audits the export as its own action, not as a read', async () => {
    await exportRecord().expect(200);

    const entry = await ctx.db.auditLog.findFirstOrThrow({
      where: {
        schoolId: school.schoolId,
        action: 'student.record_exported',
        entityId: studentId,
      },
    });
    expect(entry.metadata).toMatchObject({
      format: 'edugear.student-export.v1',
    });
  });

  it('does not copy the record into the audit metadata', async () => {
    await exportRecord().expect(200);

    const entry = await ctx.db.auditLog.findFirstOrThrow({
      where: { action: 'student.record_exported', entityId: studentId },
    });
    const serialised = JSON.stringify(entry.metadata);
    expect(serialised).not.toContain('Awolowo');
    expect(serialised).not.toContain('AS');
    expect(serialised).not.toContain('peanuts');
  });

  // -------------------------------------------------------------------------

  describe('access', () => {
    it('refuses someone who holds only part of what the export contains', async () => {
      // The bursar can read fees. The export also carries results and
      // attendance, so without those permissions this would be a way to read
      // them without holding the permission to read them.
      const response = await exportRecord(readOnlyToken).expect(403);
      expect(response.body.message).toContain('results.read');
    });

    it('404s for another school’s student', async () => {
      await exportRecord(other.accessToken).expect(404);
    });

    it('refuses an unauthenticated request', async () => {
      await ctx.http().get(`/api/students/${studentId}/export`).expect(401);
    });

    it('404s for a student that does not exist', async () => {
      await ctx
        .http()
        .get('/api/students/11111111-1111-4111-8111-111111111111/export')
        .set(auth())
        .expect(404);
    });
  });
});
