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
      .send({ middleName: 'Ngozi', religion: 'Christianity' })
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
      .send({ classArmId: armA, religion: 'Islam' })
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
});
