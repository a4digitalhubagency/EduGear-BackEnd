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

describe('Class arms', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let teacherMembershipId: string;
  let revokedMembershipId: string;
  let classId: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const auth = () => bearer(school.accessToken);

  const createArm = (overrides: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post('/api/academics/class-arms')
      .set(auth())
      .send({ classId, name: 'A', ...overrides });

  async function addStudent(
    armId: string,
    studentId: string,
    status = 'ACTIVE',
  ) {
    return ctx.db.student.create({
      data: {
        schoolId: school.schoolId,
        studentId,
        firstName: 'Ada',
        lastName: 'Test',
        gender: 'FEMALE',
        admissionDate: new Date('2025-09-15'),
        classArmId: armId,
        status: status as 'ACTIVE',
      },
    });
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Arms College' });
    other = await registerSchool(ctx, { schoolName: 'Rival Academy' });

    const role = await ctx.db.role.findFirstOrThrow({
      where: { schoolId: school.schoolId, slug: 'TEACHER' },
    });
    const hash = await argon2.hash('StrongPass123', { type: argon2.argon2id });

    const teacher = await ctx.db.user.create({
      data: {
        email: 'formteacher@arms.test',
        firstName: 'Ngozi',
        lastName: 'Okafor',
        passwordHash: hash,
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
      },
    });
    const membership = await ctx.db.membership.create({
      data: {
        userId: teacher.id,
        schoolId: school.schoolId,
        roleId: role.id,
        status: MembershipStatus.ACTIVE,
        acceptedAt: new Date(),
      },
    });
    teacherMembershipId = membership.id;

    const former = await ctx.db.user.create({
      data: {
        email: 'former@arms.test',
        firstName: 'Tunde',
        lastName: 'Left',
        passwordHash: hash,
        status: UserStatus.ACTIVE,
      },
    });
    const revoked = await ctx.db.membership.create({
      data: {
        userId: former.id,
        schoolId: school.schoolId,
        roleId: role.id,
        status: MembershipStatus.REVOKED,
      },
    });
    revokedMembershipId = revoked.id;
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
  });

  it('creates an arm', async () => {
    const response = await createArm({ capacity: 35 }).expect(201);
    expect(response.body).toMatchObject({
      name: 'A',
      className: 'JSS1',
      classLevel: 1,
      fullName: 'JSS1 A',
      capacity: 35,
      formTeacherId: null,
      formTeacherName: null,
      studentCount: 0,
    });
  });

  it('creates an arm with a form teacher and resolves their name', async () => {
    const response = await createArm({
      formTeacherId: teacherMembershipId,
    }).expect(201);
    expect(response.body.formTeacherName).toBe('Ngozi Okafor');
  });

  it('rejects a form teacher who is not active staff', async () => {
    const response = await createArm({
      formTeacherId: revokedMembershipId,
    }).expect(400);
    expect(response.body.message).toMatch(/active staff/i);
  });

  it('rejects a form teacher from another school', async () => {
    const outsider = await ctx.db.membership.findFirstOrThrow({
      where: { schoolId: other.schoolId },
    });

    await createArm({ formTeacherId: outsider.id }).expect(404);
  });

  it('rejects an unknown class', async () => {
    await createArm({
      classId: '11111111-1111-4111-8111-111111111111',
    }).expect(404);
  });

  it('rejects a duplicate arm name within one class', async () => {
    await createArm().expect(201);

    const response = await createArm({ name: 'a' }).expect(409);
    expect(response.body.errorCode).toBe('DUPLICATE_RESOURCE');
  });

  it('allows the same arm name in a different class', async () => {
    await createArm().expect(201);

    const second = await ctx
      .http()
      .post('/api/academics/classes')
      .set(auth())
      .send({ name: 'JSS2', level: 2 })
      .expect(201);

    await createArm({ classId: second.body.id }).expect(201);
  });

  it.each([0, 501])('rejects capacity %p', async (capacity) => {
    await createArm({ capacity }).expect(400);
  });

  it('lists arms grouped by class level then name', async () => {
    const second = await ctx
      .http()
      .post('/api/academics/classes')
      .set(auth())
      .send({ name: 'JSS2', level: 2 })
      .expect(201);

    await createArm({ classId: second.body.id, name: 'A' }).expect(201);
    await createArm({ name: 'B' }).expect(201);
    await createArm({ name: 'A' }).expect(201);

    const response = await ctx
      .http()
      .get('/api/academics/class-arms?sortOrder=asc')
      .set(auth())
      .expect(200);
    expect(
      response.body.data.map((a: { fullName: string }) => a.fullName),
    ).toEqual(['JSS1 A', 'JSS1 B', 'JSS2 A']);
  });

  it('filters by class', async () => {
    const second = await ctx
      .http()
      .post('/api/academics/classes')
      .set(auth())
      .send({ name: 'JSS2', level: 2 })
      .expect(201);
    await createArm().expect(201);
    await createArm({ classId: second.body.id }).expect(201);

    const response = await ctx
      .http()
      .get(`/api/academics/class-arms?classId=${classId}`)
      .set(auth())
      .expect(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].classId).toBe(classId);
  });

  it('counts only active students', async () => {
    const arm = await createArm().expect(201);
    await addStudent(arm.body.id, 'ADM-200');
    await addStudent(arm.body.id, 'ADM-201', 'GRADUATED');

    const response = await ctx
      .http()
      .get(`/api/academics/class-arms/${arm.body.id}`)
      .set(auth())
      .expect(200);
    expect(response.body.studentCount).toBe(1);
  });

  it('clears the form teacher with null', async () => {
    const arm = await createArm({ formTeacherId: teacherMembershipId }).expect(
      201,
    );

    const response = await ctx
      .http()
      .patch(`/api/academics/class-arms/${arm.body.id}`)
      .set(auth())
      .send({ formTeacherId: null })
      .expect(200);
    expect(response.body.formTeacherId).toBeNull();
    expect(response.body.formTeacherName).toBeNull();
  });

  it('refuses to move an arm to another class', async () => {
    const arm = await createArm().expect(201);

    // classId is absent from UpdateClassArmDto, so forbidNonWhitelisted rejects it.
    await ctx
      .http()
      .patch(`/api/academics/class-arms/${arm.body.id}`)
      .set(auth())
      .send({ classId })
      .expect(400);
  });

  it('refuses a capacity below the students already enrolled', async () => {
    const arm = await createArm({ capacity: 30 }).expect(201);
    await addStudent(arm.body.id, 'ADM-300');
    await addStudent(arm.body.id, 'ADM-301');

    const response = await ctx
      .http()
      .patch(`/api/academics/class-arms/${arm.body.id}`)
      .set(auth())
      .send({ capacity: 1 })
      .expect(409);
    expect(response.body.message).toMatch(/below the 2 student/);
  });

  it('deletes an empty arm', async () => {
    const arm = await createArm().expect(201);

    await ctx
      .http()
      .delete(`/api/academics/class-arms/${arm.body.id}`)
      .set(auth())
      .expect(204);
  });

  it('refuses to delete an arm that still has students', async () => {
    const arm = await createArm().expect(201);
    await addStudent(arm.body.id, 'ADM-400');

    const response = await ctx
      .http()
      .delete(`/api/academics/class-arms/${arm.body.id}`)
      .set(auth())
      .expect(409);
    expect(response.body.message).toMatch(/still has 1 active student/);
  });

  it('blocks deleting a class while it still has arms', async () => {
    await createArm().expect(201);

    await ctx
      .http()
      .delete(`/api/academics/classes/${classId}`)
      .set(auth())
      .expect(409);
  });

  it('never shows another school its neighbour’s arms', async () => {
    await createArm().expect(201);

    const response = await ctx
      .http()
      .get('/api/academics/class-arms')
      .set(bearer(other.accessToken))
      .expect(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('refuses to hang an arm off another school’s class', async () => {
    await ctx
      .http()
      .post('/api/academics/class-arms')
      .set(bearer(other.accessToken))
      .send({ classId, name: 'A' })
      .expect(404);
  });
});
