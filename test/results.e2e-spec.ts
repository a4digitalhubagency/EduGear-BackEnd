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

interface Staff {
  token: string;
  membershipId: string;
}

/**
 * A term's results end to end: configure, enter scores, compute, submit,
 * approve, publish, print — and every refusal along the way.
 */
describe('Results', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let passwordHash: string;

  let termId: string;
  let secondTermStart: string;
  let classId: string;
  let armA: string;
  let armB: string;
  let maths: string;
  let english: string;
  let french: string;
  let components: { id: string; name: string; maxScore: number }[];
  let students: { id: string; firstName: string }[];

  let mathsTeacher: Staff;
  let englishTeacher: Staff;
  let formTeacher: Staff;
  let outsider: Staff;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const head = () => bearer(school.accessToken);

  async function staff(email: string, firstName: string): Promise<Staff> {
    const role = await ctx.db.role.findFirstOrThrow({
      where: { schoolId: school.schoolId, slug: 'TEACHER' },
    });
    const user = await ctx.db.user.create({
      data: {
        email,
        firstName,
        lastName: 'Teacher',
        passwordHash,
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

  /** [ca1, ca2, ca3, exam] for one student in one subject. */
  function marks(studentId: string, values: (number | null)[]) {
    return values.map((score, i) => ({
      studentId,
      componentId: components[i].id,
      score,
    }));
  }

  const save = (
    token: string,
    subjectId: string,
    entries: unknown[],
    classArmId = armA,
  ) =>
    ctx
      .http()
      .put('/api/results/scores')
      .set(bearer(token))
      .send({ classArmId, subjectId, termId, entries });

  const compute = (token = school.accessToken) =>
    ctx
      .http()
      .post('/api/results/sheets/compute')
      .set(bearer(token))
      .send({ classArmId: armA, termId });

  /** Ada 90/80, Bola 70/70, Chidi 70/70 in maths/english; Ada takes French. */
  async function enterFullClass() {
    const [ada, bola, chidi] = students;
    await save(mathsTeacher.token, maths, [
      ...marks(ada.id, [10, 10, 10, 60]),
      ...marks(bola.id, [7, 7, 6, 50]),
      ...marks(chidi.id, [7, 7, 6, 50]),
    ]).expect(200);
    await save(englishTeacher.token, english, [
      ...marks(ada.id, [8, 8, 8, 56]),
      ...marks(bola.id, [7, 7, 6, 50]),
      ...marks(chidi.id, [7, 7, 6, 50]),
    ]).expect(200);
    await save(formTeacher.token, french, [
      ...marks(ada.id, [9, 9, 9, 63]),
    ]).expect(200);
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    passwordHash = await argon2.hash('StrongPass123', {
      type: argon2.argon2id,
    });
    school = await registerSchool(ctx, { schoolName: 'Results College' });
    other = await registerSchool(ctx, { schoolName: 'Rival Academy' });

    mathsTeacher = await staff('maths@results.test', 'Maths');
    englishTeacher = await staff('english@results.test', 'English');
    formTeacher = await staff('form@results.test', 'Form');
    outsider = await staff('outsider@results.test', 'Outsider');
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    for (const table of [
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
    ] as const) {
      await (
        ctx.db[table] as { deleteMany: (a: object) => Promise<unknown> }
      ).deleteMany({});
    }

    const setup = await ctx
      .http()
      .post('/api/results/setup-defaults')
      .set(head())
      .expect(200);
    components = setup.body.scheme.components;

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
        })
        .expect(201)
    ).body.id;
    secondTermStart = '2026-01-06';
    await ctx
      .http()
      .post('/api/academics/terms')
      .set(head())
      .send({
        sessionId: session.body.id,
        name: 'SECOND',
        startDate: secondTermStart,
        endDate: '2026-04-10',
      })
      .expect(201);

    classId = (
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

    const subject = async (name: string, code: string) =>
      (
        await ctx
          .http()
          .post('/api/results/subjects')
          .set(head())
          .send({ name, code })
          .expect(201)
      ).body.id;
    maths = await subject('Mathematics', 'MTH');
    english = await subject('English Language', 'ENG');
    french = await subject('French', 'FRE');

    for (const [subjectId, isCompulsory] of [
      [maths, true],
      [english, true],
      [french, false],
    ] as const) {
      await ctx
        .http()
        .post(`/api/results/classes/${classId}/subjects`)
        .set(head())
        .send({ subjectId, isCompulsory })
        .expect(201);
    }

    const assign = (subjectId: string, teacher: Staff) =>
      ctx
        .http()
        .put(`/api/results/class-arms/${armA}/subjects/${subjectId}/teacher`)
        .set(head())
        .send({ teacherMembershipId: teacher.membershipId })
        .expect(200);
    await assign(maths, mathsTeacher);
    await assign(english, englishTeacher);
    await assign(french, formTeacher);

    const imported = await ctx
      .http()
      .post('/api/students/import')
      .set(head())
      .send({
        rows: ['Ada', 'Bola', 'Chidi'].map((firstName) => ({
          firstName,
          lastName: 'Student',
          gender: 'F',
          admissionDate: '2025-09-15',
          classArmId: armA,
        })),
      })
      .expect(200);
    students = imported.body.rows.map(
      (row: { studentId: string }, i: number) => ({
        id: row.studentId,
        firstName: ['Ada', 'Bola', 'Chidi'][i],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  describe('configuration', () => {
    it('applies the defaults once, and is idempotent', async () => {
      const again = await ctx
        .http()
        .post('/api/results/setup-defaults')
        .set(head())
        .expect(200);
      expect(again.body.created).toEqual([]);
      expect(
        again.body.scheme.components.map(
          (c: { maxScore: number }) => c.maxScore,
        ),
      ).toEqual([10, 10, 10, 70]);
      expect(again.body.grading.bands[0]).toMatchObject({
        grade: 'A1',
        minScore: 75,
        maxScore: 100,
      });
    });

    it('refuses a scheme that does not add up to 100', async () => {
      const response = await ctx
        .http()
        .put('/api/results/assessment-scheme')
        .set(head())
        .send({
          components: [
            { name: 'CA', maxScore: 30 },
            { name: 'Exam', maxScore: 60 },
          ],
        })
        .expect(400);
      expect(response.body.message).toMatch(/add up to 90/);
    });

    it('fixes the marks once scores exist, but allows renaming and swapping names', async () => {
      await save(
        mathsTeacher.token,
        maths,
        marks(students[0].id, [5, null, null, null]),
      ).expect(200);

      await ctx
        .http()
        .put('/api/results/assessment-scheme')
        .set(head())
        .send({
          components: [
            { name: 'CA', maxScore: 30 },
            { name: 'Exam', maxScore: 70 },
          ],
        })
        .expect(409);

      const renamed = await ctx
        .http()
        .put('/api/results/assessment-scheme')
        .set(head())
        .send({
          components: [
            { name: '2nd CA', maxScore: 10 },
            { name: '1st CA', maxScore: 10 },
            { name: 'Project', maxScore: 10 },
            { name: 'Examination', maxScore: 70 },
          ],
        })
        .expect(200);
      expect(renamed.body.locked).toBe(true);
      expect(
        renamed.body.components.map((c: { name: string }) => c.name),
      ).toEqual(['2nd CA', '1st CA', 'Project', 'Examination']);
    });

    it('refuses a grading scale with a gap', async () => {
      const response = await ctx
        .http()
        .put('/api/results/grading-scale')
        .set(head())
        .send({
          bands: [
            {
              grade: 'P',
              minScore: 50,
              maxScore: 100,
              remark: 'Pass',
              isPass: true,
            },
            {
              grade: 'F',
              minScore: 0,
              maxScore: 44,
              remark: 'Fail',
              isPass: false,
            },
          ],
        })
        .expect(400);
      expect(response.body.message).toMatch(/Nothing covers 45–49/);
    });

    it('keeps subject names and codes unique', async () => {
      await ctx
        .http()
        .post('/api/results/subjects')
        .set(head())
        .send({ name: 'Maths', code: 'mth' })
        .expect(409);
      await ctx
        .http()
        .post('/api/results/subjects')
        .set(head())
        .send({ name: 'Physics', code: 'P' })
        .expect(400);
    });

    it('lets only a principal change the scheme', async () => {
      await ctx
        .http()
        .put('/api/results/assessment-scheme')
        .set(bearer(formTeacher.token))
        .send({ components: [{ name: 'Exam', maxScore: 100 }] })
        .expect(403);
    });

    it('shows each arm’s teacher on a class’s subjects', async () => {
      const response = await ctx
        .http()
        .get(`/api/results/classes/${classId}/subjects`)
        .set(head())
        .expect(200);
      const mathsRow = response.body.find(
        (s: { name: string }) => s.name === 'Mathematics',
      );
      expect(mathsRow.teachers).toEqual([
        expect.objectContaining({ armName: 'A', teacherName: 'Maths Teacher' }),
        expect.objectContaining({ armName: 'B', teacherMembershipId: null }),
      ]);
    });

    it('gives a teacher their own classes', async () => {
      const response = await ctx
        .http()
        .get('/api/results/teaching-assignments?mine=true')
        .set(bearer(mathsTeacher.token))
        .expect(200);
      expect(response.body).toEqual([
        expect.objectContaining({
          className: 'JSS1 A',
          subjectName: 'Mathematics',
        }),
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Scores
  // -------------------------------------------------------------------------

  describe('score entry', () => {
    it('lets the assigned teacher enter scores and grades the complete rows', async () => {
      const response = await save(mathsTeacher.token, maths, [
        ...marks(students[0].id, [10, 9, 8, 55]),
        ...marks(students[1].id, [5, null, null, null]),
      ]).expect(200);

      const ada = response.body.students.find(
        (s: { studentId: string }) => s.studentId === students[0].id,
      );
      expect(ada).toMatchObject({ total: 82, grade: 'A1', complete: true });
      const bola = response.body.students.find(
        (s: { studentId: string }) => s.studentId === students[1].id,
      );
      expect(bola).toMatchObject({ total: 5, grade: null, complete: false });
      expect(response.body).toMatchObject({
        entered: 5,
        expected: 12,
        canEdit: true,
      });
    });

    it('refuses a teacher who is not assigned to the subject', async () => {
      const response = await save(
        outsider.token,
        maths,
        marks(students[0].id, [5, 5, 5, 50]),
      ).expect(403);
      expect(response.body.message).toMatch(
        /Only the teacher assigned to JSS1 A Mathematics/,
      );
    });

    it('refuses an arm with no teacher assigned, pointing at the principal', async () => {
      await ctx.db.student.update({
        where: { id: students[0].id },
        data: { classArmId: armB },
      });
      const response = await save(
        mathsTeacher.token,
        maths,
        marks(students[0].id, [5, 5, 5, 50]),
        armB,
      ).expect(403);
      expect(response.body.message).toMatch(
        /No teacher is assigned to JSS1 B Mathematics/,
      );
    });

    it('lets the principal cover for any teacher', async () => {
      await save(
        school.accessToken,
        maths,
        marks(students[0].id, [5, 5, 5, 50]),
      ).expect(200);
    });

    it('reports every bad cell and saves none of them', async () => {
      const response = await save(mathsTeacher.token, maths, [
        ...marks(students[0].id, [10, 9, 8, 55]),
        { studentId: students[1].id, componentId: components[0].id, score: 11 },
        { studentId: students[1].id, componentId: components[3].id, score: -1 },
      ]).expect(400);

      expect(response.body.message).toMatch(
        /2 score\(s\) could not be saved; nothing was changed/,
      );
      expect(
        response.body.details.map(
          (d: { constraints: string[] }) => d.constraints[0],
        ),
      ).toEqual(['1st CA is out of 10; got 11', 'Exam is out of 70; got -1']);
      expect(await ctx.db.score.count()).toBe(0);
    });

    it('refuses a student who is not in the arm', async () => {
      await ctx.db.student.update({
        where: { id: students[2].id },
        data: { classArmId: armB },
      });
      const response = await save(
        mathsTeacher.token,
        maths,
        marks(students[2].id, [5, 5, 5, 50]),
      ).expect(400);
      expect(response.body.details[0].constraints[0]).toMatch(
        /not an active member of JSS1 A/,
      );
    });

    it('clears a score with null', async () => {
      await save(
        mathsTeacher.token,
        maths,
        marks(students[0].id, [10, 9, 8, 55]),
      ).expect(200);
      await save(mathsTeacher.token, maths, [
        {
          studentId: students[0].id,
          componentId: components[3].id,
          score: null,
        },
      ]).expect(200);
      expect(await ctx.db.score.count()).toBe(3);
    });

    it('counts only takers of an elective as expected', async () => {
      await save(
        formTeacher.token,
        french,
        marks(students[0].id, [9, 9, 9, 63]),
      ).expect(200);
      const grid = await ctx
        .http()
        .get(
          `/api/results/scores?classArmId=${armA}&subjectId=${french}&termId=${termId}`,
        )
        .set(bearer(formTeacher.token))
        .expect(200);
      expect(grid.body).toMatchObject({
        isCompulsory: false,
        entered: 4,
        expected: 4,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Computing and the approval flow
  // -------------------------------------------------------------------------

  describe('result sheets', () => {
    it('computes positions with ties and lists what is missing', async () => {
      await save(mathsTeacher.token, maths, [
        ...marks(students[0].id, [10, 10, 10, 60]),
        ...marks(students[1].id, [7, 7, 6, 50]),
      ]).expect(200);

      const sheet = await compute(formTeacher.token).expect(200);
      expect(sheet.body).toMatchObject({
        status: 'DRAFT',
        ready: false,
        stale: false,
      });
      // Chidi has nothing in maths; nobody has English yet.
      expect(sheet.body.missing.length).toBe(4);
    });

    it('lets only the form teacher or principal compute', async () => {
      const response = await compute(mathsTeacher.token).expect(403);
      expect(response.body.message).toMatch(/Only the form teacher of JSS1 A/);
    });

    it('ranks the class by average, ties sharing a place', async () => {
      await enterFullClass();
      const sheet = await compute(formTeacher.token).expect(200);

      expect(sheet.body.ready).toBe(true);
      expect(
        sheet.body.students.map(
          (s: { studentName: string; positionLabel: string }) => [
            s.studentName,
            s.positionLabel,
          ],
        ),
      ).toEqual([
        ['Student, Ada', '1st'],
        ['Student, Bola', '2nd'],
        ['Student, Chidi', '2nd'],
      ]);
      // Ada's three subjects: (90 + 80 + 90) / 3.
      expect(sheet.body.students[0]).toMatchObject({
        subjectCount: 3,
        averageScore: 86.67,
      });
      const mathsStats = sheet.body.subjects.find(
        (s: { subjectName: string }) => s.subjectName === 'Mathematics',
      );
      expect(mathsStats).toMatchObject({
        highest: 90,
        lowest: 70,
        average: 76.67,
      });
    });

    it('marks a computed sheet stale when a score changes', async () => {
      await enterFullClass();
      const first = await compute(formTeacher.token).expect(200);
      expect(first.body.stale).toBe(false);

      await save(
        mathsTeacher.token,
        maths,
        marks(students[1].id, [8, 7, 6, 50]),
      ).expect(200);
      const detail = await ctx
        .http()
        .get(`/api/results/sheets/${first.body.id}`)
        .set(head())
        .expect(200);
      expect(detail.body).toMatchObject({ stale: true, ready: false });
    });

    it('refuses to submit while any score is missing, naming it', async () => {
      await save(
        mathsTeacher.token,
        maths,
        marks(students[0].id, [10, 10, 10, 60]),
      ).expect(200);
      const sheet = await compute(formTeacher.token).expect(200);

      const response = await ctx
        .http()
        .post(`/api/results/sheets/${sheet.body.id}/submit`)
        .set(bearer(formTeacher.token))
        .expect(409);
      expect(response.body.message).toMatch(
        /Student, Bola — Mathematics \(1st CA, 2nd CA, 3rd CA, Exam\)/,
      );
    });

    it('runs submit → approve → publish, freezing scores from submission', async () => {
      await enterFullClass();
      const sheet = await compute(formTeacher.token).expect(200);
      const id = sheet.body.id;

      const submitted = await ctx
        .http()
        .post(`/api/results/sheets/${id}/submit`)
        .set(bearer(formTeacher.token))
        .expect(200);
      expect(submitted.body.status).toBe('SUBMITTED');

      const locked = await save(
        mathsTeacher.token,
        maths,
        marks(students[0].id, [1, 1, 1, 1]),
      ).expect(409);
      expect(locked.body.message).toMatch(
        /JSS1 A results for the first term are SUBMITTED and locked/,
      );

      // A teacher holds no results.publish.
      await ctx
        .http()
        .post(`/api/results/sheets/${id}/approve`)
        .set(bearer(formTeacher.token))
        .expect(403);
      // Publishing skips approval: refused.
      await ctx
        .http()
        .post(`/api/results/sheets/${id}/publish`)
        .set(head())
        .expect(409);

      await ctx
        .http()
        .post(`/api/results/sheets/${id}/approve`)
        .set(head())
        .expect(200);
      const published = await ctx
        .http()
        .post(`/api/results/sheets/${id}/publish`)
        .set(head())
        .expect(200);
      expect(published.body.status).toBe('PUBLISHED');
      expect(published.body.publishedAt).toBeTruthy();

      const audit = await ctx.db.auditLog.findMany({
        where: { schoolId: school.schoolId, entityId: id },
        select: { action: true },
      });
      expect(audit.map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'result.submitted',
          'result.approved',
          'result.published',
        ]),
      );
    });

    it('returns even a published sheet to draft, with a reason, and unfreezes it', async () => {
      await enterFullClass();
      const id = (await compute(formTeacher.token).expect(200)).body.id;
      await ctx
        .http()
        .post(`/api/results/sheets/${id}/submit`)
        .set(bearer(formTeacher.token))
        .expect(200);
      await ctx
        .http()
        .post(`/api/results/sheets/${id}/approve`)
        .set(head())
        .expect(200);
      await ctx
        .http()
        .post(`/api/results/sheets/${id}/publish`)
        .set(head())
        .expect(200);

      const returned = await ctx
        .http()
        .post(`/api/results/sheets/${id}/return`)
        .set(head())
        .send({ reason: 'Maths exam for Bola was mis-keyed' })
        .expect(200);
      expect(returned.body).toMatchObject({
        status: 'DRAFT',
        returnedReason: 'Maths exam for Bola was mis-keyed',
        publishedAt: null,
      });

      await save(
        mathsTeacher.token,
        maths,
        marks(students[1].id, [7, 7, 6, 55]),
      ).expect(200);
    });

    it('keeps comments across a recompute and fixes them at the right stage', async () => {
      await enterFullClass();
      const id = (await compute(formTeacher.token).expect(200)).body.id;
      const ada = students[0].id;

      await ctx
        .http()
        .patch(`/api/results/sheets/${id}/students/${ada}/comment`)
        .set(bearer(formTeacher.token))
        .send({ formTeacherComment: 'A diligent and cheerful pupil.' })
        .expect(200);

      const recomputed = await compute(formTeacher.token).expect(200);
      const adaRow = recomputed.body.students.find(
        (s: { studentId: string }) => s.studentId === ada,
      );
      expect(adaRow.formTeacherComment).toBe('A diligent and cheerful pupil.');

      // Another teacher cannot write the form teacher's comment.
      await ctx
        .http()
        .patch(`/api/results/sheets/${id}/students/${ada}/comment`)
        .set(bearer(mathsTeacher.token))
        .send({ formTeacherComment: 'x' })
        .expect(403);

      await ctx
        .http()
        .post(`/api/results/sheets/${id}/submit`)
        .set(bearer(formTeacher.token))
        .expect(200);
      await ctx
        .http()
        .post(`/api/results/sheets/${id}/approve`)
        .set(head())
        .expect(200);

      await ctx
        .http()
        .patch(`/api/results/sheets/${id}/students/${ada}/comment`)
        .set(bearer(formTeacher.token))
        .send({ formTeacherComment: 'Changed after approval' })
        .expect(409);
      await ctx
        .http()
        .patch(`/api/results/sheets/${id}/students/${ada}/comment`)
        .set(head())
        .send({ principalComment: 'Excellent result. Keep it up.' })
        .expect(200);

      await ctx
        .http()
        .post(`/api/results/sheets/${id}/publish`)
        .set(head())
        .expect(200);
      await ctx
        .http()
        .patch(`/api/results/sheets/${id}/students/${ada}/comment`)
        .set(head())
        .send({ principalComment: 'Too late' })
        .expect(409);
    });
  });

  // -------------------------------------------------------------------------
  // Report cards
  // -------------------------------------------------------------------------

  describe('report cards', () => {
    it('prints a full report card from the snapshot', async () => {
      await enterFullClass();
      const id = (await compute(formTeacher.token).expect(200)).body.id;
      await ctx
        .http()
        .patch(`/api/results/sheets/${id}/students/${students[0].id}/comment`)
        .set(bearer(formTeacher.token))
        .send({ formTeacherComment: 'A diligent pupil.' })
        .expect(200);

      const card = await ctx
        .http()
        .get(`/api/results/report-cards/${students[0].id}?termId=${termId}`)
        .set(head())
        .expect(200);

      expect(card.body).toMatchObject({
        className: 'JSS1 A',
        termName: 'FIRST',
        sessionName: '2025/2026',
        status: 'DRAFT',
        position: 1,
        positionLabel: '1st',
        outOf: 3,
        subjectCount: 3,
        passes: 3,
        failures: 0,
        averageScore: 86.67,
        formTeacherName: 'Form Teacher',
        formTeacherComment: 'A diligent pupil.',
        attendance: null,
      });
      expect(card.body.school.name).toBe('Results College');
      expect(card.body.nextTermBegins.slice(0, 10)).toBe(secondTermStart);
      expect(card.body.gradeScale).toHaveLength(9);

      const mathsLine = card.body.subjects.find(
        (s: { subjectName: string }) => s.subjectName === 'Mathematics',
      );
      expect(mathsLine).toMatchObject({
        total: 90,
        grade: 'A1',
        remark: 'Excellent',
        positionLabel: '1st',
        classHighest: 90,
        classLowest: 70,
      });
      expect(
        mathsLine.components.map((c: { score: number }) => c.score),
      ).toEqual([10, 10, 10, 60]);
    });

    it('prints a whole class in position order', async () => {
      await enterFullClass();
      const id = (await compute(formTeacher.token).expect(200)).body.id;

      const cards = await ctx
        .http()
        .get(`/api/results/sheets/${id}/report-cards`)
        .set(head())
        .expect(200);
      expect(
        cards.body.map((c: { positionLabel: string }) => c.positionLabel),
      ).toEqual(['1st', '2nd', '2nd']);
    });

    it('404s for a term with no results', async () => {
      await ctx
        .http()
        .get(`/api/results/report-cards/${students[0].id}?termId=${termId}`)
        .set(head())
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // History is protected
  // -------------------------------------------------------------------------

  describe('deletion guards', () => {
    it('protects a term, student, arm and subject that have results', async () => {
      await enterFullClass();
      await compute(formTeacher.token).expect(200);

      await ctx
        .http()
        .delete(`/api/academics/terms/${termId}`)
        .set(head())
        .expect(409);
      await ctx
        .http()
        .delete(`/api/students/${students[0].id}`)
        .set(head())
        .expect(409);
      await ctx
        .http()
        .delete(`/api/results/subjects/${maths}`)
        .set(head())
        .expect(409);
      await ctx
        .http()
        .delete(`/api/results/classes/${classId}/subjects/${maths}`)
        .set(head())
        .expect(409);

      await ctx.db.student.updateMany({
        where: { classArmId: armA },
        data: { status: 'GRADUATED' },
      });
      await ctx
        .http()
        .delete(`/api/academics/class-arms/${armA}`)
        .set(head())
        .expect(409);
    });
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('never shows another school our results', async () => {
      await enterFullClass();
      const id = (await compute(formTeacher.token).expect(200)).body.id;

      await ctx
        .http()
        .get(`/api/results/sheets/${id}`)
        .set(bearer(other.accessToken))
        .expect(404);
      await ctx
        .http()
        .get(`/api/results/report-cards/${students[0].id}?termId=${termId}`)
        .set(bearer(other.accessToken))
        .expect(404);
      const list = await ctx
        .http()
        .get('/api/results/sheets')
        .set(bearer(other.accessToken))
        .expect(200);
      expect(list.body.data).toHaveLength(0);
    });

    it('refuses another school writing scores into our class', async () => {
      await ctx
        .http()
        .post('/api/results/setup-defaults')
        .set(bearer(other.accessToken))
        .expect(200);
      await ctx
        .http()
        .put('/api/results/scores')
        .set(bearer(other.accessToken))
        .send({
          classArmId: armA,
          subjectId: maths,
          termId,
          entries: [
            {
              studentId: students[0].id,
              componentId: components[0].id,
              score: 1,
            },
          ],
        })
        .expect(404);
    });
  });
});
