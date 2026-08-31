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

describe('Classes', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let teacherToken: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const auth = () => bearer(school.accessToken);

  const createClass = (overrides: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post('/api/academics/classes')
      .set(auth())
      .send({ name: 'JSS1', level: 1, ...overrides });

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Classes College' });
    other = await registerSchool(ctx, { schoolName: 'Rival Academy' });

    const role = await ctx.db.role.findFirstOrThrow({
      where: { schoolId: school.schoolId, slug: 'TEACHER' },
    });
    const user = await ctx.db.user.create({
      data: {
        email: 'teacher@classes.test',
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
      .send({ email: 'teacher@classes.test', password: 'StrongPass123' })
      .expect(200);
    teacherToken = login.body.tokens.accessToken;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.db.classArm.deleteMany({});
    await ctx.db.class.deleteMany({});
  });

  it('creates a class', async () => {
    const response = await createClass().expect(201);
    expect(response.body).toMatchObject({
      name: 'JSS1',
      level: 1,
      armCount: 0,
      studentCount: 0,
    });
  });

  it('trims a padded name', async () => {
    const response = await createClass({ name: '  JSS1  ' }).expect(201);
    expect(response.body.name).toBe('JSS1');
  });

  it('rejects a duplicate name regardless of case', async () => {
    await createClass().expect(201);

    const response = await createClass({ name: 'jss1', level: 2 }).expect(409);
    expect(response.body.errorCode).toBe('DUPLICATE_RESOURCE');
  });

  it('rejects a level already in use, since promotion walks levels', async () => {
    await createClass().expect(201);

    const response = await createClass({ name: 'JSS One', level: 1 }).expect(
      409,
    );
    expect(response.body.message).toMatch(/Level 1 is already used/);
  });

  it.each([0, 21, -1, 1.5])('rejects level %p', async (level) => {
    await createClass({ level }).expect(400);
  });

  it('rejects an empty name', async () => {
    await createClass({ name: '   ' }).expect(400);
  });

  it('rejects an unknown field', async () => {
    await createClass({ streams: 3 }).expect(400);
  });

  it('lists classes in level order by default', async () => {
    await createClass({ name: 'SS1', level: 4 }).expect(201);
    await createClass({ name: 'JSS1', level: 1 }).expect(201);
    await createClass({ name: 'JSS2', level: 2 }).expect(201);

    const response = await ctx
      .http()
      .get('/api/academics/classes?sortOrder=asc')
      .set(auth())
      .expect(200);
    expect(response.body.data.map((c: { name: string }) => c.name)).toEqual([
      'JSS1',
      'JSS2',
      'SS1',
    ]);
  });

  it('searches by name', async () => {
    await createClass({ name: 'JSS1', level: 1 }).expect(201);
    await createClass({ name: 'SS1', level: 4 }).expect(201);

    const response = await ctx
      .http()
      .get('/api/academics/classes?search=jss')
      .set(auth())
      .expect(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].name).toBe('JSS1');
  });

  it('updates a class', async () => {
    const created = await createClass().expect(201);

    const response = await ctx
      .http()
      .patch(`/api/academics/classes/${created.body.id}`)
      .set(auth())
      .send({ name: 'JSS One' })
      .expect(200);
    expect(response.body.name).toBe('JSS One');
  });

  it('allows an update that keeps its own name and level', async () => {
    const created = await createClass().expect(201);

    await ctx
      .http()
      .patch(`/api/academics/classes/${created.body.id}`)
      .set(auth())
      .send({ name: 'JSS1', level: 1 })
      .expect(200);
  });

  it('rejects an update onto another class’s level', async () => {
    await createClass({ name: 'JSS1', level: 1 }).expect(201);
    const second = await createClass({ name: 'JSS2', level: 2 }).expect(201);

    await ctx
      .http()
      .patch(`/api/academics/classes/${second.body.id}`)
      .set(auth())
      .send({ level: 1 })
      .expect(409);
  });

  it('deletes an empty class', async () => {
    const created = await createClass().expect(201);

    await ctx
      .http()
      .delete(`/api/academics/classes/${created.body.id}`)
      .set(auth())
      .expect(204);

    await ctx
      .http()
      .get(`/api/academics/classes/${created.body.id}`)
      .set(auth())
      .expect(404);
  });

  it('refuses to delete a class that still has arms', async () => {
    const created = await createClass().expect(201);
    await ctx.db.classArm.create({
      data: {
        schoolId: school.schoolId,
        classId: created.body.id,
        name: 'A',
      },
    });

    const response = await ctx
      .http()
      .delete(`/api/academics/classes/${created.body.id}`)
      .set(auth())
      .expect(409);
    expect(response.body.message).toMatch(/still has 1 arm/);
  });

  it('counts arms and active students only', async () => {
    const created = await createClass().expect(201);
    const arm = await ctx.db.classArm.create({
      data: { schoolId: school.schoolId, classId: created.body.id, name: 'A' },
    });
    await ctx.db.student.createMany({
      data: [
        {
          schoolId: school.schoolId,
          studentId: 'ADM-100',
          firstName: 'Ada',
          lastName: 'One',
          gender: 'FEMALE',
          admissionDate: new Date('2025-09-15'),
          classArmId: arm.id,
          status: 'ACTIVE',
        },
        {
          schoolId: school.schoolId,
          studentId: 'ADM-101',
          firstName: 'Bola',
          lastName: 'Two',
          gender: 'MALE',
          admissionDate: new Date('2025-09-15'),
          classArmId: arm.id,
          status: 'GRADUATED',
        },
      ],
    });

    const response = await ctx
      .http()
      .get(`/api/academics/classes/${created.body.id}`)
      .set(auth())
      .expect(200);
    expect(response.body.armCount).toBe(1);
    expect(response.body.studentCount).toBe(1);
  });

  it('lets a teacher read but not create', async () => {
    await ctx
      .http()
      .get('/api/academics/classes')
      .set(bearer(teacherToken))
      .expect(200);

    const denied = await ctx
      .http()
      .post('/api/academics/classes')
      .set(bearer(teacherToken))
      .send({ name: 'JSS1', level: 1 })
      .expect(403);
    expect(denied.body.errorCode).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('never shows another school its neighbour’s classes', async () => {
    await createClass().expect(201);

    const response = await ctx
      .http()
      .get('/api/academics/classes')
      .set(bearer(other.accessToken))
      .expect(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('lets two schools use the same class name and level', async () => {
    await createClass().expect(201);

    await ctx
      .http()
      .post('/api/academics/classes')
      .set(bearer(other.accessToken))
      .send({ name: 'JSS1', level: 1 })
      .expect(201);
  });

  it('404s when another school requests a class by id', async () => {
    const created = await createClass().expect(201);

    await ctx
      .http()
      .get(`/api/academics/classes/${created.body.id}`)
      .set(bearer(other.accessToken))
      .expect(404);
  });
});
