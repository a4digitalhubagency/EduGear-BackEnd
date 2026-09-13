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

describe('Attendance', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let formTeacher: { token: string; membershipId: string };
  let otherTeacher: { token: string; membershipId: string };
  let termId: string;
  let armA: string;
  let armB: string;
  let students: string[];

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const head = () => bearer(school.accessToken);

  async function teacher(email: string) {
    const role = await ctx.db.role.findFirstOrThrow({
      where: { schoolId: school.schoolId, slug: 'TEACHER' },
    });
    const user = await ctx.db.user.create({
      data: {
        email,
        firstName: 'Form',
        lastName: 'Teacher',
        passwordHash: await argon2.hash('StrongPass123', {
          type: argon2.argon2id,
        }),
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
      },
    });
    const membership = await ctx.db.membership.create({
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
      .send({ email, password: 'StrongPass123' })
      .expect(200);
    return {
      token: login.body.tokens.accessToken,
      membershipId: membership.id,
    };
  }

  const take = (
    token: string,
    date: string,
    statuses: string[],
    classArmId = armA,
  ) =>
    ctx
      .http()
      .put('/api/attendance/register')
      .set(bearer(token))
      .send({
        classArmId,
        date,
        entries: statuses.map((status, i) => ({
          studentId: students[i],
          status,
        })),
      });

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Attendance College' });
    other = await registerSchool(ctx, { schoolName: 'Rival Academy' });
    formTeacher = await teacher('form@attendance.test');
    otherTeacher = await teacher('other@attendance.test');
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.db.attendanceRecord.deleteMany({});
    await ctx.db.student.deleteMany({});
    await ctx.db.classArm.deleteMany({});
    await ctx.db.class.deleteMany({});
    await ctx.db.term.deleteMany({});
    await ctx.db.academicSession.deleteMany({});

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
    armA = (
      await ctx
        .http()
        .post('/api/academics/class-arms')
        .set(head())
        .send({ classId, name: 'A', formTeacherId: formTeacher.membershipId })
        .expect(201)
    ).body.id;
    armB = (
      await ctx
        .http()
        .post('/api/academics/class-arms')
        .set(head())
        .send({ classId, name: 'B' })
        .expect(201)
    ).body.id;

    const imported = await ctx
      .http()
      .post('/api/students/import')
      .set(head())
      .send({
        rows: ['Ada', 'Bola', 'Chidi'].map((firstName) => ({
          firstName,
          lastName: 'Pupil',
          gender: 'F',
          admissionDate: '2025-09-15',
          classArmId: armA,
        })),
      })
      .expect(200);
    students = imported.body.rows.map(
      (row: { studentId: string }) => row.studentId,
    );
  });

  it('lets the form teacher take the register', async () => {
    const response = await take(formTeacher.token, '2025-10-06', [
      'PRESENT',
      'ABSENT',
      'LATE',
    ]).expect(200);
    expect(response.body).toMatchObject({
      className: 'JSS1 A',
      termName: 'FIRST',
      taken: true,
      canEdit: true,
      present: 1,
      absent: 1,
      late: 1,
    });
  });

  it('refuses a teacher who is not the form teacher', async () => {
    const response = await take(otherTeacher.token, '2025-10-06', [
      'PRESENT',
      'PRESENT',
      'PRESENT',
    ]).expect(403);
    expect(response.body.message).toMatch(/Only the form teacher of JSS1 A/);
  });

  it('lets an administrator take any register', async () => {
    await take(school.accessToken, '2025-10-06', [
      'PRESENT',
      'PRESENT',
      'PRESENT',
    ]).expect(200);
  });

  it('amends a register rather than duplicating it', async () => {
    await take(formTeacher.token, '2025-10-06', [
      'PRESENT',
      'ABSENT',
      'PRESENT',
    ]).expect(200);
    await take(formTeacher.token, '2025-10-06', [
      'PRESENT',
      'EXCUSED',
      'PRESENT',
    ]).expect(200);
    expect(await ctx.db.attendanceRecord.count()).toBe(3);
  });

  it('refuses a future date', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000)
      .toISOString()
      .slice(0, 10);
    await take(formTeacher.token, tomorrow, [
      'PRESENT',
      'PRESENT',
      'PRESENT',
    ]).expect(400);
  });

  it('refuses a date outside every term', async () => {
    const response = await take(formTeacher.token, '2025-12-25', [
      'PRESENT',
      'PRESENT',
      'PRESENT',
    ]).expect(400);
    expect(response.body.message).toMatch(/not inside any term/);
  });

  it('refuses a student from another arm', async () => {
    await ctx.db.student.update({
      where: { id: students[2] },
      data: { classArmId: armB },
    });
    const response = await take(formTeacher.token, '2025-10-06', [
      'PRESENT',
      'PRESENT',
      'PRESENT',
    ]).expect(400);
    expect(response.body.details[0].field).toBe('entries[2]');
  });

  it('shows the register for a day before and after it is taken', async () => {
    const before = await ctx
      .http()
      .get(`/api/attendance/register?classArmId=${armA}&date=2025-10-06`)
      .set(bearer(formTeacher.token))
      .expect(200);
    expect(before.body.taken).toBe(false);
    expect(
      before.body.students.every(
        (s: { status: string | null }) => s.status === null,
      ),
    ).toBe(true);
  });

  it('summarises a term, counting late as present and excused as absent', async () => {
    await take(formTeacher.token, '2025-10-06', [
      'PRESENT',
      'ABSENT',
      'LATE',
    ]).expect(200);
    await take(formTeacher.token, '2025-10-07', [
      'PRESENT',
      'EXCUSED',
      'PRESENT',
    ]).expect(200);

    const summary = await ctx
      .http()
      .get(`/api/attendance/summary?classArmId=${armA}&termId=${termId}`)
      .set(head())
      .expect(200);
    const bola = summary.body.find(
      (s: { studentId: string }) => s.studentId === students[1],
    );
    expect(bola).toMatchObject({
      daysOpen: 2,
      present: 0,
      absent: 2,
      excused: 1,
      rate: 0,
    });
    const chidi = summary.body.find(
      (s: { studentId: string }) => s.studentId === students[2],
    );
    expect(chidi).toMatchObject({
      daysOpen: 2,
      present: 2,
      late: 1,
      rate: 100,
    });
  });

  it('refuses to delete an arm or student with attendance on file', async () => {
    await take(formTeacher.token, '2025-10-06', [
      'PRESENT',
      'PRESENT',
      'PRESENT',
    ]).expect(200);
    await ctx
      .http()
      .delete(`/api/students/${students[0]}`)
      .set(head())
      .expect(409);

    await ctx.db.student.updateMany({
      where: { classArmId: armA },
      data: { status: 'GRADUATED' },
    });
    const response = await ctx
      .http()
      .delete(`/api/academics/class-arms/${armA}`)
      .set(head())
      .expect(409);
    expect(response.body.message).toMatch(/attendance/);
  });

  it('never lets another school read or write our registers', async () => {
    await ctx
      .http()
      .get(`/api/attendance/register?classArmId=${armA}&date=2025-10-06`)
      .set(bearer(other.accessToken))
      .expect(404);
    await ctx
      .http()
      .put('/api/attendance/register')
      .set(bearer(other.accessToken))
      .send({
        classArmId: armA,
        date: '2025-10-06',
        entries: [{ studentId: students[0], status: 'PRESENT' }],
      })
      .expect(404);
  });
});
