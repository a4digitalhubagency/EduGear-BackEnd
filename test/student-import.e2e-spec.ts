import {
  closeTestApp,
  createTestApp,
  registerSchool,
  RegisteredSchool,
  resetDatabase,
  TestContext,
} from './utils/test-app';

describe('Student import', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let jss3B: string;
  let tinyArm: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const auth = () => bearer(school.accessToken);

  const csv = (text: string, options: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post('/api/students/import/csv')
      .set(auth())
      .send({ csv: text, ...options });

  const json = (
    rows: Record<string, unknown>[],
    options: Record<string, unknown> = {},
  ) =>
    ctx
      .http()
      .post('/api/students/import')
      .set(auth())
      .send({ rows, ...options });

  const HEADER =
    'Adm No,Surname,First Name,Sex,Date of Birth,Admission Date,Class,Parent Name,Parent Phone,Parent Email,Relationship';

  async function arm(
    className: string,
    level: number,
    armName: string,
    capacity?: number,
  ) {
    const existing = await ctx.db.class.findFirst({
      where: { schoolId: school.schoolId, name: className },
    });
    const classId =
      existing?.id ??
      (
        await ctx
          .http()
          .post('/api/academics/classes')
          .set(auth())
          .send({ name: className, level })
          .expect(201)
      ).body.id;
    return (
      await ctx
        .http()
        .post('/api/academics/class-arms')
        .set(auth())
        .send({ classId, name: armName, capacity })
        .expect(201)
    ).body.id as string;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Import College' });
    other = await registerSchool(ctx, { schoolName: 'Rival Academy' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.db.studentGuardian.deleteMany({});
    await ctx.db.guardian.deleteMany({});
    await ctx.db.student.deleteMany({});
    await ctx.db.classArm.deleteMany({});
    await ctx.db.class.deleteMany({});

    await arm('JSS1', 1, 'A');
    jss3B = await arm('JSS3', 3, 'B');
    tinyArm = await arm('SS1', 4, 'A', 2);
  });

  // -------------------------------------------------------------------------
  // A real spreadsheet
  // -------------------------------------------------------------------------

  it('imports an Excel export: BOM, CRLF, day-first dates, M/F, class labels', async () => {
    const file =
      '﻿' +
      [
        HEADER,
        ',Okafor,Adaeze,F,14/03/2013,15/09/2025,JSS1 A,Mr Emeka Okafor,0803 123 4567,emeka@example.com,Father',
        ',Okafor,Obinna,M,02/07/2011,15/09/2025,jss 3b,Mr Emeka Okafor,08031234567,,Father',
      ].join('\r\n');

    const response = await csv(file).expect(200);

    expect(response.body).toMatchObject({
      outcome: 'IMPORTED',
      imported: 2,
      failed: 0,
      guardiansCreated: 1,
    });
    expect(
      response.body.rows.map(
        (r: { admissionNumber: string }) => r.admissionNumber,
      ),
    ).toEqual(['2025/0001', '2025/0002']);
    expect(
      response.body.rows.map((r: { className: string }) => r.className),
    ).toEqual(['JSS1 A', 'JSS3 B']);
    // Siblings sharing a phone share one parent record.
    expect(
      response.body.rows.map((r: { guardian: string }) => r.guardian),
    ).toEqual(['CREATED', 'SHARED']);

    const guardians = await ctx.db.guardian.findMany({
      where: { schoolId: school.schoolId },
      include: { students: true },
    });
    expect(guardians).toHaveLength(1);
    expect(guardians[0]).toMatchObject({
      firstName: 'Emeka',
      lastName: 'Okafor',
    });
    expect(guardians[0].students).toHaveLength(2);
    expect(guardians[0].students.every((link) => link.isPrimary)).toBe(true);

    const adaeze = await ctx.db.student.findFirstOrThrow({
      where: { firstName: 'Adaeze' },
    });
    // 14/03/2013 is 14 March, read day-first.
    expect(adaeze.dateOfBirth?.toISOString().slice(0, 10)).toBe('2013-03-14');
    expect(adaeze.gender).toBe('FEMALE');
  });

  it('round-trips its own template', async () => {
    const template = await ctx
      .http()
      .get('/api/students/import/template')
      .set(auth())
      .expect(200)
      .expect('Content-Type', /text\/csv/);

    expect(template.text.charCodeAt(0)).toBe(0xfeff);
    expect(template.headers['content-disposition']).toMatch(/attachment/);

    const response = await csv(template.text).expect(200);
    expect(response.body).toMatchObject({ outcome: 'IMPORTED', imported: 2 });
  });

  // -------------------------------------------------------------------------
  // Reporting every problem
  // -------------------------------------------------------------------------

  it('reports every problem on every row, and imports nothing when atomic', async () => {
    const file = [
      HEADER,
      ',Okafor,Adaeze,F,14/03/2013,15/09/2025,JSS1 A,,,,',
      ',,Obinna,X,31/02/2011,15/09/2025,JSS9 Z,,,,',
      ',Bello,Musa,M,02/07/2011,15/09/2025,JSS1 A,Okafor,12345,not-an-email,Neighbour',
    ].join('\n');

    const response = await csv(file).expect(200);
    expect(response.body).toMatchObject({
      outcome: 'REJECTED',
      imported: 0,
      failed: 2,
      valid: 1,
    });

    const [first, second, third] = response.body.rows;
    expect(first.status).toBe('VALID');

    // Row 2: missing surname, bad sex, impossible date, unknown class — all four.
    expect(second.status).toBe('FAILED');
    expect(second.line).toBe(3);
    expect(second.errors.map((e: { field: string }) => e.field).sort()).toEqual(
      ['classArm', 'dateOfBirth', 'gender', 'lastName'],
    );
    expect(
      second.errors.find((e: { field: string }) => e.field === 'classArm')
        .message,
    ).toMatch(/Class "JSS9 Z" does not exist/);

    // Row 3: every parent column wrong at once.
    expect(third.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'guardianEmail',
      'guardianName',
      'guardianPhone',
      'guardianRelationship',
    ]);

    expect(
      await ctx.db.student.count({ where: { schoolId: school.schoolId } }),
    ).toBe(0);
  });

  it('imports the good rows and returns the rest when partial', async () => {
    const file = [
      HEADER,
      ',Okafor,Adaeze,F,14/03/2013,15/09/2025,JSS1 A,,,,',
      ',Bad,Row,X,,15/09/2025,,,,,',
      ',Bello,Musa,M,,15/09/2025,JSS3 B,,,,',
    ].join('\n');

    const response = await csv(file, { mode: 'PARTIAL' }).expect(200);
    expect(response.body).toMatchObject({
      outcome: 'PARTIAL',
      imported: 2,
      failed: 1,
    });
    expect(response.body.rows.map((r: { status: string }) => r.status)).toEqual(
      ['IMPORTED', 'FAILED', 'IMPORTED'],
    );
    expect(
      await ctx.db.student.count({ where: { schoolId: school.schoolId } }),
    ).toBe(2);
  });

  it('previews on a dry run, down to the admission numbers, and writes nothing', async () => {
    const file = [
      HEADER,
      ',Okafor,Adaeze,F,,15/09/2025,JSS1 A,Mr Emeka Okafor,08031234567,,Father',
      'BSC/17,Bello,Musa,M,,15/09/2025,JSS1 A,,,,',
    ].join('\n');

    const response = await csv(file, { dryRun: true }).expect(200);
    expect(response.body).toMatchObject({
      outcome: 'VALIDATED',
      dryRun: true,
      imported: 0,
      valid: 2,
    });
    expect(
      response.body.rows.map(
        (r: { admissionNumber: string }) => r.admissionNumber,
      ),
    ).toEqual(['2025/0001', 'BSC/17']);
    expect(
      await ctx.db.student.count({ where: { schoolId: school.schoolId } }),
    ).toBe(0);
    expect(
      await ctx.db.guardian.count({ where: { schoolId: school.schoolId } }),
    ).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Matching what is already on file
  // -------------------------------------------------------------------------

  it('links to a parent already on file, whatever format the phone is in', async () => {
    const existing = await ctx
      .http()
      .post('/api/guardians')
      .set(auth())
      .send({
        firstName: 'Emeka',
        lastName: 'Okafor',
        phone: '08031234567',
        email: 'emeka@example.com',
      })
      .expect(201);

    const file = [
      HEADER,
      ',Okafor,Adaeze,F,,15/09/2025,JSS1 A,Emeka Okafo,+234 803 123 4567,,Father',
    ].join('\n');

    const response = await csv(file).expect(200);
    expect(response.body).toMatchObject({
      guardiansCreated: 0,
      guardiansMatched: 1,
    });

    const row = response.body.rows[0];
    expect(row.guardian).toBe('MATCHED');
    // The spelling differs, so the registrar is told who it was linked to.
    expect(row.warnings.join(' ')).toMatch(/already on file as Emeka Okafor/);

    const links = await ctx.db.studentGuardian.findMany({
      where: { guardianId: existing.body.id },
    });
    expect(links).toHaveLength(1);
  });

  it('refuses a row whose phone and email belong to two different parents', async () => {
    await ctx
      .http()
      .post('/api/guardians')
      .set(auth())
      .send({ firstName: 'Emeka', lastName: 'Okafor', phone: '08031234567' })
      .expect(201);
    await ctx
      .http()
      .post('/api/guardians')
      .set(auth())
      .send({
        firstName: 'Ngozi',
        lastName: 'Eze',
        phone: '08099998888',
        email: 'ngozi@example.com',
      })
      .expect(201);

    const file = [
      HEADER,
      ',Okafor,Adaeze,F,,15/09/2025,JSS1 A,Emeka Okafor,08031234567,ngozi@example.com,Father',
    ].join('\n');

    const response = await csv(file).expect(200);
    expect(response.body.rows[0].errors[0].message).toMatch(
      /Parent Phone belongs to Emeka Okafor but Parent Email belongs to Ngozi Eze/,
    );
  });

  it('rejects admission numbers repeated in the file or already on file', async () => {
    await ctx
      .http()
      .post('/api/students')
      .set(auth())
      .send({
        firstName: 'On',
        lastName: 'File',
        gender: 'MALE',
        admissionDate: '2025-09-15',
        studentId: 'ADM-1',
      })
      .expect(201);

    const file = [
      HEADER,
      'ADM-1,Okafor,Adaeze,F,,15/09/2025,,,,,',
      'ADM-2,Bello,Musa,M,,15/09/2025,,,,,',
      'ADM-2,Eze,Chidi,M,,15/09/2025,,,,,',
    ].join('\n');

    const response = await csv(file, { mode: 'PARTIAL' }).expect(200);
    const messages = response.body.rows.map(
      (r: { errors: { message: string }[] }) =>
        r.errors.map((e) => e.message).join(''),
    );
    expect(messages[0]).toMatch(/already in use: ADM-1/);
    expect(messages[1]).toBe('');
    expect(messages[2]).toMatch(
      /appears twice in this file \(first on row 2\)/,
    );
  });

  it('warns about a child who looks already enrolled, without refusing', async () => {
    await ctx
      .http()
      .post('/api/students')
      .set(auth())
      .send({
        firstName: 'Adaeze',
        lastName: 'Okafor',
        gender: 'FEMALE',
        dateOfBirth: '2013-03-14',
        admissionDate: '2025-09-15',
      })
      .expect(201);

    const file = [HEADER, ',Okafor,Adaeze,F,14/03/2013,15/09/2025,,,,,'].join(
      '\n',
    );

    const response = await csv(file).expect(200);
    expect(response.body.outcome).toBe('IMPORTED');
    expect(response.body.rows[0].warnings[0]).toMatch(
      /Possibly already on file as 2025\/0001/,
    );
  });

  // -------------------------------------------------------------------------
  // Capacity and defaults
  // -------------------------------------------------------------------------

  it('fills an arm to capacity in file order and refuses the rest', async () => {
    const file = [
      HEADER,
      ',A,One,M,,15/09/2025,SS1 A,,,,',
      ',B,Two,M,,15/09/2025,SS1 A,,,,',
      ',C,Three,M,,15/09/2025,SS1 A,,,,',
    ].join('\n');

    const response = await csv(file, { mode: 'PARTIAL' }).expect(200);
    expect(response.body.rows.map((r: { status: string }) => r.status)).toEqual(
      ['IMPORTED', 'IMPORTED', 'FAILED'],
    );
    expect(response.body.rows[2].errors[0].message).toMatch(
      /SS1 A is full \(2\/2\)/,
    );
    expect(await ctx.db.student.count({ where: { classArmId: tinyArm } })).toBe(
      2,
    );
  });

  it('does not let a failing row take a seat', async () => {
    const file = [
      HEADER,
      ',A,One,X,,15/09/2025,SS1 A,,,,',
      ',B,Two,M,,15/09/2025,SS1 A,,,,',
      ',C,Three,M,,15/09/2025,SS1 A,,,,',
    ].join('\n');

    const response = await csv(file, { mode: 'PARTIAL' }).expect(200);
    // Row 1 is invalid, so rows 2 and 3 both fit in the two seats.
    expect(response.body.imported).toBe(2);
  });

  it('applies a default admission date and class to rows without them', async () => {
    const file = [
      'Surname,First Name,Sex',
      'Okafor,Adaeze,F',
      'Bello,Musa,M',
    ].join('\n');

    const response = await csv(file, {
      defaultAdmissionDate: '2025-09-15',
      defaultClassArmId: jss3B,
    }).expect(200);

    expect(response.body.imported).toBe(2);
    expect(await ctx.db.student.count({ where: { classArmId: jss3B } })).toBe(
      2,
    );
  });

  it('asks for an admission date when there is neither a column nor a default', async () => {
    const response = await csv(
      'Surname,First Name,Sex\nOkafor,Adaeze,F',
    ).expect(200);
    expect(response.body.rows[0].errors[0].message).toMatch(
      /set a default admission date/,
    );
  });

  // -------------------------------------------------------------------------
  // The file itself
  // -------------------------------------------------------------------------

  it('names a missing required column', async () => {
    const response = await csv('First Name,Sex\nAda,F').expect(400);
    expect(response.body.message).toMatch(
      /missing required column\(s\): Surname/,
    );
  });

  it('reports columns it ignored', async () => {
    const response = await csv(
      'Surname,First Name,Sex,Admission Date,Shoe Size\nOkafor,Adaeze,F,15/09/2025,4',
    ).expect(200);
    expect(response.body.fileWarnings[0]).toMatch(/Shoe Size/);
    expect(response.body.imported).toBe(1);
  });

  it('points at the line of a malformed file', async () => {
    const response = await csv(
      'Surname,First Name\nOkafor,"never closed',
    ).expect(400);
    expect(response.body.message).toMatch(/^Line 2:/);
  });

  it('refuses more than 500 students in one file', async () => {
    const rows = Array.from(
      { length: 501 },
      (_, i) => `S${i},F${i},M,15/09/2025`,
    );
    const response = await csv(
      ['Surname,First Name,Sex,Admission Date', ...rows].join('\n'),
    ).expect(400);
    expect(response.body.message).toMatch(/this file has 501/);
  });

  it('imports a full 500-row file with parents in one go', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => {
      const family = Math.floor(i / 2); // pairs of siblings
      const phone = `0803${String(1000000 + family).padStart(7, '0')}`;
      return `,Family${family},Child${i},${i % 2 ? 'M' : 'F'},01/01/2012,15/09/2025,,Mr Parent Family${family},${phone},,Father,"${'Plot 12, Long Street Estate, off Ring Road'.padEnd(150, '.')}"`;
    });
    const file = [`${HEADER},Address`, ...rows].join('\n');
    // Comfortably past Express's 100 KB default body limit.
    expect(Buffer.byteLength(file)).toBeGreaterThan(100 * 1024);

    const response = await csv(file).expect(200);
    expect(response.body).toMatchObject({
      outcome: 'IMPORTED',
      imported: 500,
      guardiansCreated: 250,
    });
  });

  // -------------------------------------------------------------------------
  // JSON rows
  // -------------------------------------------------------------------------

  it('imports JSON rows keyed by field name', async () => {
    const response = await json([
      {
        firstName: 'Adaeze',
        lastName: 'Okafor',
        gender: 'female',
        admissionDate: '2025-09-15',
        classArm: 'JSS1 A',
        shoeSize: 4,
      },
    ]).expect(200);

    expect(response.body.imported).toBe(1);
    expect(response.body.fileWarnings[0]).toMatch(/shoeSize/);
  });

  // -------------------------------------------------------------------------
  // Permissions and tenancy
  // -------------------------------------------------------------------------

  it('does not let an import create parents the caller could not create by hand', async () => {
    const permissions = await ctx.db.permission.findMany({
      where: { key: { in: ['students.read', 'students.create'] } },
    });
    const role = await ctx.db.role.create({
      data: {
        schoolId: school.schoolId,
        name: 'Admissions Clerk',
        slug: 'admissions-clerk',
        permissions: {
          create: permissions.map((permission) => ({
            permissionId: permission.id,
          })),
        },
      },
    });
    const user = await ctx.db.user.create({
      data: {
        email: 'clerk@import.test',
        firstName: 'Clerk',
        lastName: 'One',
        passwordHash: await (await import('argon2')).hash('StrongPass123'),
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    await ctx.db.membership.create({
      data: {
        userId: user.id,
        schoolId: school.schoolId,
        roleId: role.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });
    const login = await ctx
      .http()
      .post('/api/auth/login')
      .send({ email: 'clerk@import.test', password: 'StrongPass123' })
      .expect(200);

    const file = [
      HEADER,
      ',Okafor,Adaeze,F,,15/09/2025,,Mr Emeka Okafor,08031234567,,Father',
      ',Bello,Musa,M,,15/09/2025,,,,,',
    ].join('\n');

    const response = await ctx
      .http()
      .post('/api/students/import/csv')
      .set(bearer(login.body.tokens.accessToken))
      .send({ csv: file, mode: 'PARTIAL' })
      .expect(200);

    expect(response.body.rows[0].errors[0].message).toMatch(
      /permission to create parent records/,
    );
    expect(response.body.rows[1].status).toBe('IMPORTED');
  });

  it('never matches another school’s classes or parents', async () => {
    await ctx
      .http()
      .post('/api/guardians')
      .set(bearer(other.accessToken))
      .send({ firstName: 'Rival', lastName: 'Parent', phone: '08031234567' })
      .expect(201);

    const file = [
      HEADER,
      ',Okafor,Adaeze,F,,15/09/2025,,Mr Emeka Okafor,08031234567,,Father',
    ].join('\n');

    const mine = await csv(file).expect(200);
    // Same phone as the rival's parent, but that parent is invisible here.
    expect(mine.body.rows[0].guardian).toBe('CREATED');

    const theirs = await ctx
      .http()
      .post('/api/students/import/csv')
      .set(bearer(other.accessToken))
      .send({ csv: [HEADER, ',X,Y,M,,15/09/2025,JSS1 A,,,,'].join('\n') })
      .expect(200);
    expect(theirs.body.rows[0].errors[0].message).toMatch(/does not exist/);
  });

  it('records a completed import in the audit trail, and a dry run not at all', async () => {
    const file = [HEADER, ',Okafor,Adaeze,F,,15/09/2025,,,,,'].join('\n');
    // Earlier tests in this suite import too, so measure the change.
    const entries = () =>
      ctx.db.auditLog.count({
        where: { schoolId: school.schoolId, action: 'student.bulk_imported' },
      });
    const before = await entries();

    await csv(file, { dryRun: true }).expect(200);
    expect(await entries()).toBe(before);

    await csv(file).expect(200);
    expect(await entries()).toBe(before + 1);

    const latest = await ctx.db.auditLog.findFirst({
      where: { schoolId: school.schoolId, action: 'student.bulk_imported' },
      orderBy: { createdAt: 'desc' },
    });
    expect(latest?.metadata).toMatchObject({ source: 'csv', imported: 1 });
  });
});
