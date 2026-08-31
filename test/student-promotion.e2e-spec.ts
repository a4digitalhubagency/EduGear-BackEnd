import {
  closeTestApp,
  createTestApp,
  registerSchool,
  RegisteredSchool,
  resetDatabase,
  TestContext,
} from './utils/test-app';

describe('Bulk import and promotion', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let jss1A: string;
  let jss2A: string;
  let smallArm: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const auth = () => bearer(school.accessToken);

  const row = (overrides: Record<string, unknown> = {}) => ({
    firstName: 'Ada',
    lastName: 'Obi',
    gender: 'FEMALE',
    admissionDate: '2025-09-15',
    ...overrides,
  });

  const bulk = (students: Record<string, unknown>[]) =>
    ctx.http().post('/api/students/bulk').set(auth()).send({ students });

  const promote = (body: Record<string, unknown>) =>
    ctx.http().post('/api/students/promotions').set(auth()).send(body);

  async function makeArm(
    className: string,
    level: number,
    armName: string,
    capacity?: number,
  ): Promise<string> {
    const klass = await ctx
      .http()
      .post('/api/academics/classes')
      .set(auth())
      .send({ name: className, level })
      .expect(201);
    const arm = await ctx
      .http()
      .post('/api/academics/class-arms')
      .set(auth())
      .send({ classId: klass.body.id, name: armName, capacity })
      .expect(201);
    return arm.body.id;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Promotion College' });
    other = await registerSchool(ctx, { schoolName: 'Rival Academy' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.db.student.deleteMany({});
    await ctx.db.classArm.deleteMany({});
    await ctx.db.class.deleteMany({});

    jss1A = await makeArm('JSS1', 1, 'A');
    jss2A = await makeArm('JSS2', 2, 'A');
    smallArm = await makeArm('JSS3', 3, 'A', 1);
  });

  // -------------------------------------------------------------------------
  // Bulk import
  // -------------------------------------------------------------------------

  it('imports a batch and numbers it sequentially', async () => {
    const response = await bulk([
      row({ firstName: 'Ada' }),
      row({ firstName: 'Bola' }),
      row({ firstName: 'Chidi' }),
    ]).expect(201);

    expect(response.body.imported).toBe(3);
    expect(
      response.body.students.map((s: { studentId: string }) => s.studentId),
    ).toEqual(['2025/0001', '2025/0002', '2025/0003']);
  });

  it('continues the sequence from students already on file', async () => {
    await bulk([row()]).expect(201);

    const response = await bulk([row({ firstName: 'Bola' })]).expect(201);
    expect(response.body.students[0].studentId).toBe('2025/0002');
  });

  it('mixes supplied and generated numbers', async () => {
    const response = await bulk([
      row({ studentId: 'BSC/1' }),
      row({ firstName: 'Bola' }),
    ]).expect(201);

    expect(
      response.body.students.map((s: { studentId: string }) => s.studentId),
    ).toEqual(['BSC/1', '2025/0001']);
  });

  it('numbers each admission year separately within one batch', async () => {
    const response = await bulk([
      row(),
      row({ firstName: 'Bola', admissionDate: '2026-09-14' }),
      row({ firstName: 'Chidi' }),
    ]).expect(201);

    expect(
      response.body.students.map((s: { studentId: string }) => s.studentId),
    ).toEqual(['2025/0001', '2026/0001', '2025/0002']);
  });

  it('places imported students in arms', async () => {
    const response = await bulk([row({ classArmId: jss1A })]).expect(201);
    expect(response.body.students[0].className).toBe('JSS1 A');
  });

  it('imports nothing when one row is invalid', async () => {
    await bulk([
      row(),
      row({ firstName: 'Bola', dateOfBirth: '2030-01-01' }),
    ]).expect(400);

    const list = await ctx.http().get('/api/students').set(auth()).expect(200);
    expect(list.body.data).toHaveLength(0);
  });

  it('names the offending row', async () => {
    const response = await bulk([
      row(),
      row({ dateOfBirth: '2030-01-01' }),
    ]).expect(400);
    expect(response.body.message).toMatch(/^Row 2:/);
  });

  it('rejects a number repeated inside the batch', async () => {
    const response = await bulk([
      row({ studentId: 'ADM-1' }),
      row({ studentId: 'ADM-1' }),
    ]).expect(409);
    expect(response.body.message).toMatch(/appears twice/);
  });

  it('rejects a number already on file', async () => {
    await bulk([row({ studentId: 'ADM-1' })]).expect(201);

    const response = await bulk([row({ studentId: 'ADM-1' })]).expect(409);
    expect(response.body.message).toMatch(/already in use: ADM-1/);
  });

  it('refuses a batch that would overfill an arm', async () => {
    const response = await bulk([
      row({ classArmId: smallArm }),
      row({ firstName: 'Bola', classArmId: smallArm }),
    ]).expect(409);
    expect(response.body.message).toMatch(/JSS3 A is full/);

    const list = await ctx.http().get('/api/students').set(auth()).expect(200);
    expect(list.body.data).toHaveLength(0);
  });

  it('rejects an empty batch', async () => {
    await bulk([]).expect(400);
  });

  it('rejects a batch over the limit', async () => {
    await bulk(Array.from({ length: 501 }, () => row())).expect(400);
  });

  it('validates nested rows', async () => {
    await bulk([row({ gender: 'OTHER' })]).expect(400);
  });

  // -------------------------------------------------------------------------
  // Promotion
  // -------------------------------------------------------------------------

  it('promotes a whole arm', async () => {
    await bulk([
      row({ classArmId: jss1A }),
      row({ firstName: 'Bola', classArmId: jss1A }),
    ]).expect(201);

    const response = await promote({
      fromClassArmId: jss1A,
      toClassArmId: jss2A,
    }).expect(200);

    expect(response.body).toMatchObject({
      promoted: 2,
      graduated: 0,
      from: 'JSS1 A',
      to: 'JSS2 A',
    });

    const moved = await ctx
      .http()
      .get(`/api/students?classArmId=${jss2A}`)
      .set(auth())
      .expect(200);
    expect(moved.body.data).toHaveLength(2);
  });

  it('promotes a named subset only', async () => {
    const imported = await bulk([
      row({ classArmId: jss1A }),
      row({ firstName: 'Bola', classArmId: jss1A }),
    ]).expect(201);

    await promote({
      fromClassArmId: jss1A,
      toClassArmId: jss2A,
      studentIds: [imported.body.students[0].id],
    }).expect(200);

    const left = await ctx
      .http()
      .get(`/api/students?classArmId=${jss1A}`)
      .set(auth())
      .expect(200);
    expect(left.body.data).toHaveLength(1);
    expect(left.body.data[0].firstName).toBe('Bola');
  });

  it('leaves non-active students behind', async () => {
    const imported = await bulk([
      row({ classArmId: jss1A }),
      row({ firstName: 'Bola', classArmId: jss1A }),
    ]).expect(201);

    await ctx
      .http()
      .patch(`/api/students/${imported.body.students[1].id}/status`)
      .set(auth())
      .send({ status: 'WITHDRAWN' })
      .expect(200);

    const response = await promote({
      fromClassArmId: jss1A,
      toClassArmId: jss2A,
    }).expect(200);
    expect(response.body.promoted).toBe(1);

    // The withdrawn student stays where they were rather than moving up.
    const withdrawn = await ctx
      .http()
      .get(`/api/students/${imported.body.students[1].id}`)
      .set(auth())
      .expect(200);
    expect(withdrawn.body.classArmId).toBe(jss1A);
  });

  it('graduates an arm and clears their places', async () => {
    await bulk([
      row({ classArmId: jss1A }),
      row({ firstName: 'Bola', classArmId: jss1A }),
    ]).expect(201);

    const response = await promote({
      fromClassArmId: jss1A,
      graduate: true,
    }).expect(200);

    expect(response.body).toMatchObject({
      promoted: 0,
      graduated: 2,
      to: null,
    });

    const graduated = await ctx
      .http()
      .get('/api/students?status=GRADUATED')
      .set(auth())
      .expect(200);
    expect(graduated.body.data).toHaveLength(2);
    expect(graduated.body.data[0].classArmId).toBeNull();
  });

  it('refuses a promotion that would overfill the target', async () => {
    await bulk([
      row({ classArmId: jss1A }),
      row({ firstName: 'Bola', classArmId: jss1A }),
    ]).expect(201);

    const response = await promote({
      fromClassArmId: jss1A,
      toClassArmId: smallArm,
    }).expect(409);
    expect(response.body.message).toMatch(/JSS3 A is full/);

    // Nothing moved.
    const stayed = await ctx
      .http()
      .get(`/api/students?classArmId=${jss1A}`)
      .set(auth())
      .expect(200);
    expect(stayed.body.data).toHaveLength(2);
  });

  it('rejects both a target and graduate', async () => {
    await promote({
      fromClassArmId: jss1A,
      toClassArmId: jss2A,
      graduate: true,
    }).expect(400);
  });

  it('rejects neither a target nor graduate', async () => {
    await promote({ fromClassArmId: jss1A }).expect(400);
  });

  it('rejects promoting an arm into itself', async () => {
    await promote({ fromClassArmId: jss1A, toClassArmId: jss1A }).expect(400);
  });

  it('rejects an empty source arm', async () => {
    const response = await promote({
      fromClassArmId: jss1A,
      toClassArmId: jss2A,
    }).expect(409);
    expect(response.body.message).toMatch(/No active students/);
  });

  it('rejects a student who is not in the source arm', async () => {
    const imported = await bulk([row({ classArmId: jss2A })]).expect(201);
    await bulk([row({ firstName: 'Bola', classArmId: jss1A })]).expect(201);

    await promote({
      fromClassArmId: jss1A,
      toClassArmId: jss2A,
      studentIds: [imported.body.students[0].id],
    }).expect(400);
  });

  it('records promotion in the audit trail', async () => {
    await bulk([row({ classArmId: jss1A })]).expect(201);
    await promote({ fromClassArmId: jss1A, toClassArmId: jss2A }).expect(200);

    const entry = await ctx.db.auditLog.findFirst({
      where: { schoolId: school.schoolId, action: 'student.promoted' },
    });
    expect(entry?.description).toMatch(/JSS1 A to JSS2 A/);
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  it('refuses to promote into another school’s arm', async () => {
    await bulk([row({ classArmId: jss1A })]).expect(201);

    await ctx
      .http()
      .post('/api/students/promotions')
      .set(bearer(other.accessToken))
      .send({ fromClassArmId: jss1A, toClassArmId: jss2A })
      .expect(404);
  });

  it('refuses to import into another school’s arm', async () => {
    await ctx
      .http()
      .post('/api/students/bulk')
      .set(bearer(other.accessToken))
      .send({ students: [row({ classArmId: jss1A })] })
      .expect(404);
  });
});
