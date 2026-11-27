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

describe('Students', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let accountantToken: string;
  let classId: string;
  let armA: string;
  let armB: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const auth = () => bearer(school.accessToken);

  const admit = (overrides: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post('/api/students')
      .set(auth())
      .send({
        firstName: 'Ada',
        lastName: 'Obi',
        gender: 'FEMALE',
        admissionDate: '2025-09-15',
        ...overrides,
      });

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Students College' });
    other = await registerSchool(ctx, { schoolName: 'Rival Academy' });

    // ACCOUNTANT holds finance permissions but not students.create.
    const role = await ctx.db.role.findFirstOrThrow({
      where: { schoolId: school.schoolId, slug: 'ACCOUNTANT' },
    });
    const user = await ctx.db.user.create({
      data: {
        email: 'bursar@students.test',
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
      .send({ email: 'bursar@students.test', password: 'StrongPass123' })
      .expect(200);
    accountantToken = login.body.tokens.accessToken;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.db.student.deleteMany({});
    await ctx.db.classArm.deleteMany({});
    await ctx.db.class.deleteMany({});

    const created = await ctx
      .http()
      .post('/api/academics/classes')
      .set(auth())
      .send({ name: 'JSS1', level: 1 })
      .expect(201);
    classId = created.body.id;

    const a = await ctx
      .http()
      .post('/api/academics/class-arms')
      .set(auth())
      .send({ classId, name: 'A', capacity: 2 })
      .expect(201);
    armA = a.body.id;

    const b = await ctx
      .http()
      .post('/api/academics/class-arms')
      .set(auth())
      .send({ classId, name: 'B' })
      .expect(201);
    armB = b.body.id;
  });

  // -------------------------------------------------------------------------
  // Admission
  // -------------------------------------------------------------------------

  it('admits a student and generates an admission number', async () => {
    const response = await admit().expect(201);

    expect(response.body).toMatchObject({
      firstName: 'Ada',
      lastName: 'Obi',
      fullName: 'Obi, Ada',
      status: 'ACTIVE',
      nationality: 'Nigerian',
      studentId: '2025/0001',
      className: null,
    });
  });

  it('numbers admissions sequentially within the year', async () => {
    await admit().expect(201);
    const second = await admit({ firstName: 'Bola' }).expect(201);
    expect(second.body.studentId).toBe('2025/0002');
  });

  it('numbers by admission year, not by calendar year', async () => {
    await admit().expect(201);
    const next = await admit({ admissionDate: '2026-09-14' }).expect(201);
    expect(next.body.studentId).toBe('2026/0001');
  });

  it('accepts a school’s own admission number', async () => {
    const response = await admit({ studentId: 'BSC/2025/017' }).expect(201);
    expect(response.body.studentId).toBe('BSC/2025/017');
  });

  it('skips hand-typed numbers when generating the next one', async () => {
    await admit({ studentId: 'BSC/2025/017' }).expect(201);
    const generated = await admit({ firstName: 'Bola' }).expect(201);
    expect(generated.body.studentId).toBe('2025/0001');
  });

  it('rejects a duplicate admission number', async () => {
    await admit({ studentId: 'ADM-1' }).expect(201);

    const response = await admit({ studentId: 'ADM-1' }).expect(409);
    expect(response.body.errorCode).toBe('DUPLICATE_RESOURCE');
  });

  it('lets two schools use the same admission number', async () => {
    await admit({ studentId: 'ADM-1' }).expect(201);

    await ctx
      .http()
      .post('/api/students')
      .set(bearer(other.accessToken))
      .send({
        firstName: 'Ada',
        lastName: 'Rival',
        gender: 'FEMALE',
        admissionDate: '2025-09-15',
        studentId: 'ADM-1',
      })
      .expect(201);
  });

  it('places a student in an arm', async () => {
    const response = await admit({ classArmId: armA }).expect(201);
    expect(response.body.className).toBe('JSS1 A');
  });

  it('refuses to admit into a full arm', async () => {
    await admit({ classArmId: armA }).expect(201);
    await admit({ firstName: 'Bola', classArmId: armA }).expect(201);

    const response = await admit({
      firstName: 'Chidi',
      classArmId: armA,
    }).expect(409);
    expect(response.body.message).toMatch(/JSS1 A is full \(2\/2\)/);
  });

  it('refuses another school’s arm', async () => {
    await ctx
      .http()
      .post('/api/students')
      .set(bearer(other.accessToken))
      .send({
        firstName: 'Ada',
        lastName: 'Rival',
        gender: 'FEMALE',
        admissionDate: '2025-09-15',
        classArmId: armA,
      })
      .expect(404);
  });

  it('rejects a birth date after admission', async () => {
    const response = await admit({ dateOfBirth: '2026-01-01' }).expect(400);
    expect(response.body.message).toMatch(/dateOfBirth must be before/);
  });

  it('rejects an invalid phone number', async () => {
    await admit({ phone: '12345' }).expect(400);
  });

  it('rejects an unknown field', async () => {
    await admit({ favouriteColour: 'blue' }).expect(400);
  });

  it('rejects a status supplied at admission', async () => {
    // Status moves through its own endpoint, so it is not part of the DTO.
    await admit({ status: 'GRADUATED' }).expect(400);
  });

  // -------------------------------------------------------------------------
  // Listing, search and filters
  // -------------------------------------------------------------------------

  it('lists active students by surname', async () => {
    await admit({ firstName: 'Zainab', lastName: 'Abubakar' }).expect(201);
    await admit({ firstName: 'Ada', lastName: 'Obi' }).expect(201);

    const response = await ctx
      .http()
      .get('/api/students?sortOrder=asc')
      .set(auth())
      .expect(200);
    expect(
      response.body.data.map((s: { lastName: string }) => s.lastName),
    ).toEqual(['Abubakar', 'Obi']);
  });

  it('hides non-active students unless asked', async () => {
    const student = await admit().expect(201);
    await ctx
      .http()
      .patch(`/api/students/${student.body.id}/status`)
      .set(auth())
      .send({ status: 'GRADUATED' })
      .expect(200);

    const active = await ctx
      .http()
      .get('/api/students')
      .set(auth())
      .expect(200);
    expect(active.body.data).toHaveLength(0);

    const all = await ctx
      .http()
      .get('/api/students?status=ALL')
      .set(auth())
      .expect(200);
    expect(all.body.data).toHaveLength(1);

    const graduated = await ctx
      .http()
      .get('/api/students?status=GRADUATED')
      .set(auth())
      .expect(200);
    expect(graduated.body.data).toHaveLength(1);
  });

  it('searches by name and admission number', async () => {
    await admit({ firstName: 'Ada', lastName: 'Obi' }).expect(201);
    await admit({ firstName: 'Bola', lastName: 'Ade' }).expect(201);

    const byName = await ctx
      .http()
      .get('/api/students?search=ada')
      .set(auth())
      .expect(200);
    // "ada" matches the first name Ada but not the surname Ade.
    expect(
      byName.body.data.map((s: { firstName: string }) => s.firstName),
    ).toEqual(['Ada']);

    const byNumber = await ctx
      .http()
      .get('/api/students?search=2025/0002')
      .set(auth())
      .expect(200);
    expect(byNumber.body.data).toHaveLength(1);
  });

  it('filters by arm, class, gender and unassigned', async () => {
    await admit({ classArmId: armA, gender: 'FEMALE' }).expect(201);
    await admit({ firstName: 'Bola', classArmId: armB, gender: 'MALE' }).expect(
      201,
    );
    await admit({ firstName: 'Chidi', gender: 'MALE' }).expect(201);

    const byArm = await ctx
      .http()
      .get(`/api/students?classArmId=${armA}`)
      .set(auth())
      .expect(200);
    expect(byArm.body.data).toHaveLength(1);

    const byClass = await ctx
      .http()
      .get(`/api/students?classId=${classId}`)
      .set(auth())
      .expect(200);
    expect(byClass.body.data).toHaveLength(2);

    const byGender = await ctx
      .http()
      .get('/api/students?gender=MALE')
      .set(auth())
      .expect(200);
    expect(byGender.body.data).toHaveLength(2);

    const unassigned = await ctx
      .http()
      .get('/api/students?unassigned=true')
      .set(auth())
      .expect(200);
    expect(unassigned.body.data).toHaveLength(1);
    expect(unassigned.body.data[0].firstName).toBe('Chidi');
  });

  it('paginates', async () => {
    await admit({ lastName: 'A' }).expect(201);
    await admit({ lastName: 'B' }).expect(201);
    await admit({ lastName: 'C' }).expect(201);

    const response = await ctx
      .http()
      .get('/api/students?limit=2&page=1')
      .set(auth())
      .expect(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.meta).toMatchObject({
      total: 3,
      totalPages: 2,
      hasNextPage: true,
    });
  });

  // -------------------------------------------------------------------------
  // Profile, update and status
  // -------------------------------------------------------------------------

  it('returns a profile with an empty guardian list', async () => {
    const student = await admit().expect(201);

    const response = await ctx
      .http()
      .get(`/api/students/${student.body.id}`)
      .set(auth())
      .expect(200);
    expect(response.body.guardians).toEqual([]);
  });

  it('updates a student', async () => {
    const student = await admit().expect(201);

    const response = await ctx
      .http()
      .patch(`/api/students/${student.body.id}`)
      .set(auth())
      .send({ middleName: 'Ngozi', nationality: 'Ghanaian' })
      .expect(200);
    expect(response.body.fullName).toBe('Obi, Ada Ngozi');
  });

  it('moves a student between arms and can unassign', async () => {
    const student = await admit({ classArmId: armA }).expect(201);

    const moved = await ctx
      .http()
      .patch(`/api/students/${student.body.id}`)
      .set(auth())
      .send({ classArmId: armB })
      .expect(200);
    expect(moved.body.className).toBe('JSS1 B');

    const cleared = await ctx
      .http()
      .patch(`/api/students/${student.body.id}`)
      .set(auth())
      .send({ classArmId: null })
      .expect(200);
    expect(cleared.body.classArmId).toBeNull();
  });

  it('refuses to move a student into a full arm', async () => {
    await admit({ classArmId: armA }).expect(201);
    await admit({ firstName: 'Bola', classArmId: armA }).expect(201);
    const third = await admit({ firstName: 'Chidi', classArmId: armB }).expect(
      201,
    );

    await ctx
      .http()
      .patch(`/api/students/${third.body.id}`)
      .set(auth())
      .send({ classArmId: armA })
      .expect(409);
  });

  it('lets a student stay put when their arm is already full', async () => {
    const first = await admit({ classArmId: armA }).expect(201);
    await admit({ firstName: 'Bola', classArmId: armA }).expect(201);

    // Same arm, so the capacity check must not treat this as an arrival.
    await ctx
      .http()
      .patch(`/api/students/${first.body.id}`)
      .set(auth())
      .send({ classArmId: armA, nationality: 'Ghanaian' })
      .expect(200);
  });

  it('refuses to change the admission number through update', async () => {
    const student = await admit().expect(201);

    await ctx
      .http()
      .patch(`/api/students/${student.body.id}`)
      .set(auth())
      .send({ studentId: 'ADM-999' })
      .expect(400);
  });

  it('changes status and records the reason', async () => {
    const student = await admit().expect(201);

    const response = await ctx
      .http()
      .patch(`/api/students/${student.body.id}/status`)
      .set(auth())
      .send({ status: 'TRANSFERRED', reason: 'Moved to Lagos' })
      .expect(200);
    expect(response.body.status).toBe('TRANSFERRED');

    const entry = await ctx.db.auditLog.findFirst({
      where: { entityId: student.body.id, action: 'student.deactivated' },
    });
    expect(entry?.metadata).toMatchObject({ reason: 'Moved to Lagos' });
  });

  it('rejects a no-op status change', async () => {
    const student = await admit().expect(201);

    const response = await ctx
      .http()
      .patch(`/api/students/${student.body.id}/status`)
      .set(auth())
      .send({ status: 'ACTIVE' })
      .expect(409);
    expect(response.body.message).toMatch(/already ACTIVE/);
  });

  it('frees a place in a full arm when a student leaves', async () => {
    const first = await admit({ classArmId: armA }).expect(201);
    await admit({ firstName: 'Bola', classArmId: armA }).expect(201);

    await ctx
      .http()
      .patch(`/api/students/${first.body.id}/status`)
      .set(auth())
      .send({ status: 'WITHDRAWN' })
      .expect(200);

    // The arm counts active students only, so the seat is now free.
    await admit({ firstName: 'Chidi', classArmId: armA }).expect(201);
  });

  it('deletes a student', async () => {
    const student = await admit().expect(201);

    await ctx
      .http()
      .delete(`/api/students/${student.body.id}`)
      .set(auth())
      .expect(204);

    await ctx
      .http()
      .get(`/api/students/${student.body.id}`)
      .set(auth())
      .expect(404);
  });

  // -------------------------------------------------------------------------
  // Authorization and tenant isolation
  // -------------------------------------------------------------------------

  it('lets an accountant read but not admit', async () => {
    await ctx
      .http()
      .get('/api/students')
      .set(bearer(accountantToken))
      .expect(200);

    const denied = await ctx
      .http()
      .post('/api/students')
      .set(bearer(accountantToken))
      .send({
        firstName: 'Ada',
        lastName: 'Obi',
        gender: 'FEMALE',
        admissionDate: '2025-09-15',
      })
      .expect(403);
    expect(denied.body.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('never shows another school its neighbour’s students', async () => {
    await admit().expect(201);

    const response = await ctx
      .http()
      .get('/api/students')
      .set(bearer(other.accessToken))
      .expect(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('404s when another school requests a student by id', async () => {
    const student = await admit().expect(201);

    await ctx
      .http()
      .get(`/api/students/${student.body.id}`)
      .set(bearer(other.accessToken))
      .expect(404);

    await ctx
      .http()
      .patch(`/api/students/${student.body.id}`)
      .set(bearer(other.accessToken))
      .send({ firstName: 'Hacked' })
      .expect(404);
  });

  // -------------------------------------------------------------------------
  // Sensitive personal data — NDP Act s.30 / s.34 / s.35
  // -------------------------------------------------------------------------

  describe('erasing sensitive personal data', () => {
    const SENSITIVE = {
      genotype: 'AS',
      bloodGroup: 'O+',
      religion: 'Christianity',
      stateOfOrigin: 'Anambra',
      lga: 'Onitsha North',
      // These five cannot be written without it — see the consent block
      // below, which is where that rule is tested.
      sensitiveDataConsent: {
        givenBy: 'Mrs Chinwe Obi',
        method: 'ADMISSION_FORM',
      },
    };

    it('clears every sensitive field and names what it erased', async () => {
      const student = await admit(SENSITIVE).expect(201);

      const response = await ctx
        .http()
        .delete(`/api/students/${student.body.id}/sensitive-data`)
        .set(auth())
        .expect(200);

      expect(response.body.erasedFields.sort()).toEqual([
        'bloodGroup',
        'genotype',
        'lga',
        'religion',
        'stateOfOrigin',
      ]);
      expect(response.body.student).toMatchObject({
        genotype: null,
        bloodGroup: null,
        religion: null,
        stateOfOrigin: null,
        lga: null,
      });

      // And it is gone from the database, not merely absent from the response.
      const row = await ctx.db.student.findUniqueOrThrow({
        where: { id: student.body.id },
      });
      expect(row.genotype).toBeNull();
      expect(row.bloodGroup).toBeNull();
      expect(row.religion).toBeNull();
      expect(row.stateOfOrigin).toBeNull();
      expect(row.lga).toBeNull();
    });

    it('leaves the rest of the record untouched', async () => {
      // The whole point of a targeted erasure: withdrawing consent for health
      // and religion must not cost the student their academic record.
      const student = await admit({
        ...SENSITIVE,
        firstName: 'Ada',
        lastName: 'Obi',
        nationality: 'Nigerian',
        addressLine: '14 Awolowo Road',
        classArmId: armA,
      }).expect(201);

      await ctx
        .http()
        .delete(`/api/students/${student.body.id}/sensitive-data`)
        .set(auth())
        .expect(200);

      const row = await ctx.db.student.findUniqueOrThrow({
        where: { id: student.body.id },
      });
      expect(row.firstName).toBe('Ada');
      expect(row.lastName).toBe('Obi');
      expect(row.addressLine).toBe('14 Awolowo Road');
      expect(row.classArmId).toBe(armA);
      // Nationality is NOT sensitive under s.65 and must survive.
      expect(row.nationality).toBe('Nigerian');
    });

    it('succeeds when there is nothing to erase', async () => {
      // Withdrawal has to be easy (s.35(2)). Failing the second attempt would
      // make a parent wonder whether the first one worked.
      const student = await admit().expect(201);

      const response = await ctx
        .http()
        .delete(`/api/students/${student.body.id}/sensitive-data`)
        .set(auth())
        .expect(200);

      expect(response.body.erasedFields).toEqual([]);
    });

    it('is idempotent', async () => {
      const student = await admit(SENSITIVE).expect(201);
      const url = `/api/students/${student.body.id}/sensitive-data`;

      const first = await ctx.http().delete(url).set(auth()).expect(200);
      const second = await ctx.http().delete(url).set(auth()).expect(200);

      expect(first.body.erasedFields).toHaveLength(5);
      expect(second.body.erasedFields).toEqual([]);
    });

    it('records an audit entry naming the fields but never the values', async () => {
      const student = await admit(SENSITIVE).expect(201);

      await ctx
        .http()
        .delete(`/api/students/${student.body.id}/sensitive-data`)
        .set(auth())
        .expect(200);

      const entry = await ctx.db.auditLog.findFirstOrThrow({
        where: {
          schoolId: school.schoolId,
          action: 'student.sensitive_data_erased',
          entityId: student.body.id,
        },
      });

      expect(entry.metadata).toMatchObject({
        erasedFields: expect.arrayContaining(['genotype', 'religion']),
      });

      // The values were the thing being erased — an audit row that preserved
      // them would defeat the erasure it is evidencing.
      const serialised = JSON.stringify(entry);
      expect(serialised).not.toContain('AS');
      expect(serialised).not.toContain('Christianity');
      expect(serialised).not.toContain('Onitsha North');
    });

    it('still audits when there was nothing to erase', async () => {
      // "We asked and held nothing" is what a school shows a regulator. If
      // only the erasing case were logged it would look like nobody asked.
      const student = await admit().expect(201);

      await ctx
        .http()
        .delete(`/api/students/${student.body.id}/sensitive-data`)
        .set(auth())
        .expect(200);

      const entry = await ctx.db.auditLog.findFirstOrThrow({
        where: {
          action: 'student.sensitive_data_erased',
          entityId: student.body.id,
        },
      });
      expect(entry.metadata).toMatchObject({ erasedFields: [] });
    });

    it('requires students.update', async () => {
      const student = await admit(SENSITIVE).expect(201);

      await ctx
        .http()
        .delete(`/api/students/${student.body.id}/sensitive-data`)
        .set(bearer(accountantToken))
        .expect(403);

      // And the data is still there, so the 403 was a real refusal.
      const row = await ctx.db.student.findUniqueOrThrow({
        where: { id: student.body.id },
      });
      expect(row.genotype).toBe('AS');
    });

    it('404s for another school’s student, and erases nothing', async () => {
      const student = await admit(SENSITIVE).expect(201);

      await ctx
        .http()
        .delete(`/api/students/${student.body.id}/sensitive-data`)
        .set(bearer(other.accessToken))
        .expect(404);

      const row = await ctx.db.student.findUniqueOrThrow({
        where: { id: student.body.id },
      });
      expect(row.genotype).toBe('AS');
      expect(row.religion).toBe('Christianity');
    });

    it('rejects an unauthenticated request', async () => {
      const student = await admit(SENSITIVE).expect(201);

      await ctx
        .http()
        .delete(`/api/students/${student.body.id}/sensitive-data`)
        .expect(401);
    });
  });
  // -------------------------------------------------------------------------
  // Parental consent to the sensitive fields — NDP Act s.26(2) / s.30 / s.35
  //
  // Schools keep genotype, blood group, religion and state of origin on their
  // paper admission forms, so EduGear keeps them too. The difference is that
  // s.30 carries no education exemption: the basis is consent, and s.26(2)
  // makes the school prove it. These tests are the proof being a row rather
  // than a sentence in a policy.
  // -------------------------------------------------------------------------

  describe('consent to sensitive personal data', () => {
    const CONSENT = {
      givenBy: 'Mrs Chinwe Obi',
      method: 'ADMISSION_FORM',
    };

    it('refuses to admit with a sensitive field and no consent', async () => {
      const response = await admit({ genotype: 'AS' }).expect(400);

      expect(response.body.errorCode).toBe('CONSENT_REQUIRED');
      // Naming the field is what lets the frontend put the tick-box next to
      // the input the registrar just filled in.
      expect(response.body.message).toContain('genotype');

      expect(await ctx.db.student.count({ where: { genotype: 'AS' } })).toBe(0);
    });

    it('names every offending field, not just the first', async () => {
      const response = await admit({
        genotype: 'AS',
        religion: 'Islam',
        lga: 'Ikeja',
      }).expect(400);

      for (const field of ['genotype', 'religion', 'lga']) {
        expect(response.body.message).toContain(field);
      }
    });

    it('admits with consent, and records who gave it and how', async () => {
      const response = await admit({
        genotype: 'AS',
        sensitiveDataConsent: CONSENT,
      }).expect(201);

      expect(response.body.genotype).toBe('AS');
      expect(response.body.sensitiveDataConsent).toMatchObject({
        givenBy: 'Mrs Chinwe Obi',
        method: 'ADMISSION_FORM',
      });
      expect(response.body.sensitiveDataConsentWithdrawnAt).toBeNull();

      const row = await ctx.db.student.findUniqueOrThrow({
        where: { id: response.body.id },
      });
      expect(row.sensitiveConsentAt).toBeInstanceOf(Date);
      expect(row.sensitiveConsentBy).toBe('Mrs Chinwe Obi');
      expect(row.sensitiveConsentMethod).toBe('ADMISSION_FORM');
    });

    // The date on the form, not the date it was typed in. A school entering
    // last term's admissions should not have the consent dated today.
    it('keeps the date the parent signed', async () => {
      const response = await admit({
        genotype: 'AS',
        sensitiveDataConsent: {
          ...CONSENT,
          givenAt: '2026-09-04T00:00:00.000Z',
        },
      }).expect(201);

      expect(response.body.sensitiveDataConsent.givenAt).toBe(
        '2026-09-04T00:00:00.000Z',
      );
    });

    it('refuses a consent dated in the future', async () => {
      const ahead = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const response = await admit({
        genotype: 'AS',
        sensitiveDataConsent: { ...CONSENT, givenAt: ahead.toISOString() },
      }).expect(400);

      expect(response.body.errorCode).toBe('VALIDATION_ERROR');
    });

    it('requires a signatory, and a real method', async () => {
      await admit({
        genotype: 'AS',
        sensitiveDataConsent: { method: 'ADMISSION_FORM' },
      }).expect(400);

      await admit({
        genotype: 'AS',
        sensitiveDataConsent: { ...CONSENT, method: 'VERBAL' },
      }).expect(400);
    });

    // -----------------------------------------------------------------------

    it('refuses to add a sensitive field to a student with no consent', async () => {
      const student = await admit().expect(201);

      const response = await ctx
        .http()
        .patch(`/api/students/${student.body.id}`)
        .set(auth())
        .send({ genotype: 'AS' })
        .expect(400);
      expect(response.body.errorCode).toBe('CONSENT_REQUIRED');

      const row = await ctx.db.student.findUniqueOrThrow({
        where: { id: student.body.id },
      });
      expect(row.genotype).toBeNull();
    });

    it('accepts the field and the consent in one request', async () => {
      const student = await admit().expect(201);

      const response = await ctx
        .http()
        .patch(`/api/students/${student.body.id}`)
        .set(auth())
        .send({ genotype: 'AS', sensitiveDataConsent: CONSENT })
        .expect(200);

      expect(response.body.genotype).toBe('AS');
      expect(response.body.sensitiveDataConsent.givenBy).toBe('Mrs Chinwe Obi');
    });

    // Consent collected once covers the field afterwards, or correcting a
    // mistyped genotype would mean re-collecting a signature every time.
    it('does not ask again once consent is on record', async () => {
      const student = await admit({
        genotype: 'AS',
        sensitiveDataConsent: CONSENT,
      }).expect(201);

      const response = await ctx
        .http()
        .patch(`/api/students/${student.body.id}`)
        .set(auth())
        .send({ genotype: 'AA' })
        .expect(200);
      expect(response.body.genotype).toBe('AA');
    });

    // An absence of consent must not make the rest of the record read-only.
    it('lets every other field be edited with no consent at all', async () => {
      const student = await admit().expect(201);

      const response = await ctx
        .http()
        .patch(`/api/students/${student.body.id}`)
        .set(auth())
        .send({ phone: '08031234567', nationality: 'Ghanaian' })
        .expect(200);

      expect(response.body.phone).toBe('08031234567');
      expect(response.body.sensitiveDataConsent).toBeNull();
    });

    // Refusing to let a school delete sensitive data until it produces a
    // consent form would be exactly backwards.
    it('never asks for consent to clear a field', async () => {
      const student = await admit().expect(201);

      await ctx
        .http()
        .patch(`/api/students/${student.body.id}`)
        .set(auth())
        .send({ genotype: null, religion: '' })
        .expect(200);
    });

    // Otherwise the column disagrees with the "missing consent" query: blank
    // reads as held by SQL and as absent by everything else.
    it('stores a blank sensitive value as null, not an empty string', async () => {
      const student = await admit().expect(201);

      await ctx
        .http()
        .patch(`/api/students/${student.body.id}`)
        .set(auth())
        .send({ genotype: '   ' })
        .expect(200);

      const row = await ctx.db.student.findUniqueOrThrow({
        where: { id: student.body.id },
      });
      expect(row.genotype).toBeNull();
    });

    // -----------------------------------------------------------------------

    it('withdraws the consent record along with the values', async () => {
      const student = await admit({
        genotype: 'AS',
        sensitiveDataConsent: CONSENT,
      }).expect(201);

      const response = await ctx
        .http()
        .delete(`/api/students/${student.body.id}/sensitive-data`)
        .set(auth())
        .expect(200);

      expect(response.body.consentWithdrawn).toBe(true);
      expect(response.body.student.sensitiveDataConsent).toBeNull();

      const row = await ctx.db.student.findUniqueOrThrow({
        where: { id: student.body.id },
      });
      expect(row.genotype).toBeNull();
      expect(row.sensitiveConsentAt).toBeNull();
      expect(row.sensitiveConsentBy).toBeNull();
      expect(row.sensitiveConsentMethod).toBeNull();
      // "They said no" has to be distinguishable from "nobody asked".
      expect(row.sensitiveConsentWithdrawnAt).toBeInstanceOf(Date);
    });

    // A school can tick the box before typing any values in. Withdrawing then
    // has to drop the record even though there is nothing to erase, or the
    // school is left claiming a basis the parent has revoked.
    it('withdraws a consent that authorised nothing', async () => {
      const student = await admit({
        sensitiveDataConsent: CONSENT,
      }).expect(201);

      const response = await ctx
        .http()
        .delete(`/api/students/${student.body.id}/sensitive-data`)
        .set(auth())
        .expect(200);

      expect(response.body.erasedFields).toEqual([]);
      expect(response.body.consentWithdrawn).toBe(true);

      const row = await ctx.db.student.findUniqueOrThrow({
        where: { id: student.body.id },
      });
      expect(row.sensitiveConsentAt).toBeNull();
      expect(row.sensitiveConsentWithdrawnAt).toBeInstanceOf(Date);
    });

    it('reports nothing withdrawn when there was no consent', async () => {
      const student = await admit().expect(201);

      const response = await ctx
        .http()
        .delete(`/api/students/${student.body.id}/sensitive-data`)
        .set(auth())
        .expect(200);

      expect(response.body.consentWithdrawn).toBe(false);
      const row = await ctx.db.student.findUniqueOrThrow({
        where: { id: student.body.id },
      });
      expect(row.sensitiveConsentWithdrawnAt).toBeNull();
    });

    // After a withdrawal the fields are refused again — the withdrawal is not
    // a one-time event that leaves the door open behind it.
    it('refuses the fields again after a withdrawal', async () => {
      const student = await admit({
        genotype: 'AS',
        sensitiveDataConsent: CONSENT,
      }).expect(201);

      await ctx
        .http()
        .delete(`/api/students/${student.body.id}/sensitive-data`)
        .set(auth())
        .expect(200);

      const response = await ctx
        .http()
        .patch(`/api/students/${student.body.id}`)
        .set(auth())
        .send({ genotype: 'AS' })
        .expect(400);
      expect(response.body.errorCode).toBe('CONSENT_REQUIRED');
    });

    it('clears the withdrawal when consent is given again', async () => {
      const student = await admit({
        genotype: 'AS',
        sensitiveDataConsent: CONSENT,
      }).expect(201);

      await ctx
        .http()
        .delete(`/api/students/${student.body.id}/sensitive-data`)
        .set(auth())
        .expect(200);

      const response = await ctx
        .http()
        .patch(`/api/students/${student.body.id}`)
        .set(auth())
        .send({ genotype: 'AS', sensitiveDataConsent: CONSENT })
        .expect(200);

      expect(response.body.sensitiveDataConsentWithdrawnAt).toBeNull();

      // A withdrawal left standing next to a live consent record would read
      // as a refusal the school is ignoring.
      const row = await ctx.db.student.findUniqueOrThrow({
        where: { id: student.body.id },
      });
      expect(row.sensitiveConsentWithdrawnAt).toBeNull();
      expect(row.sensitiveConsentAt).toBeInstanceOf(Date);
    });

    // -----------------------------------------------------------------------

    it('audits the consent as its own action', async () => {
      await ctx.db.auditLog.deleteMany({});
      const student = await admit({
        genotype: 'AS',
        sensitiveDataConsent: CONSENT,
      }).expect(201);

      const entry = await ctx.db.auditLog.findFirstOrThrow({
        where: {
          action: 'student.sensitive_consent_recorded',
          entityId: student.body.id,
        },
      });
      expect(entry.metadata).toMatchObject({ method: 'ADMISSION_FORM' });

      // The signatory's name lives on the student row, where the retention
      // schedule destroys it with the data it authorises. An audit entry
      // outlives that by years, so copying the name here would reinstate what
      // minimisation had just removed.
      expect(JSON.stringify(entry)).not.toContain('Chinwe');
    });

    it('records the consent event on an update too', async () => {
      await ctx.db.auditLog.deleteMany({});
      const student = await admit().expect(201);

      await ctx
        .http()
        .patch(`/api/students/${student.body.id}`)
        .set(auth())
        .send({ genotype: 'AS', sensitiveDataConsent: CONSENT })
        .expect(200);

      expect(
        await ctx.db.auditLog.count({
          where: {
            action: 'student.sensitive_consent_recorded',
            entityId: student.body.id,
          },
        }),
      ).toBe(1);
    });

    it('writes no consent event when a request carried none', async () => {
      await ctx.db.auditLog.deleteMany({});
      const student = await admit().expect(201);

      await ctx
        .http()
        .patch(`/api/students/${student.body.id}`)
        .set(auth())
        .send({ firstName: 'Adaeze' })
        .expect(200);

      expect(
        await ctx.db.auditLog.count({
          where: { action: 'student.sensitive_consent_recorded' },
        }),
      ).toBe(0);
    });

    // -----------------------------------------------------------------------

    it('lists the students still owed a consent record', async () => {
      const withConsent = await admit({
        lastName: 'Consented',
        genotype: 'AS',
        sensitiveDataConsent: CONSENT,
      }).expect(201);
      const plain = await admit({ lastName: 'Plain' }).expect(201);

      // The state every migrated record starts in, and the only way to reach
      // it through the API is a direct write — which is the point: the list
      // exists for data that arrived before the rule did.
      const migrated = await admit({ lastName: 'Migrated' }).expect(201);
      await ctx.db.student.update({
        where: { id: migrated.body.id },
        data: { genotype: 'AA' },
      });

      const response = await ctx
        .http()
        .get('/api/students?sensitiveConsentMissing=true')
        .set(auth())
        .expect(200);

      const ids = response.body.data.map((row: { id: string }) => row.id);
      expect(ids).toContain(migrated.body.id);
      expect(ids).not.toContain(withConsent.body.id);
      // A student holding nothing sensitive is not owed a consent record.
      expect(ids).not.toContain(plain.body.id);
      // The count has to agree with the page, or a school clears the list and
      // the badge still says there is work left.
      expect(response.body.meta.total).toBe(ids.length);
    });

    it('keeps the list inside the school', async () => {
      const student = await admit().expect(201);
      await ctx.db.student.update({
        where: { id: student.body.id },
        data: { genotype: 'AA' },
      });

      const response = await ctx
        .http()
        .get('/api/students?sensitiveConsentMissing=true')
        .set(bearer(other.accessToken))
        .expect(200);
      expect(response.body.data).toHaveLength(0);
    });
  });
});
