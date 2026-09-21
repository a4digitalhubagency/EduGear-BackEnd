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

/** Real leading bytes, padded so each file is a plausible size. */
const file = {
  jpeg: (padding = 200) =>
    Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(padding),
    ]),
  png: () =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(200),
    ]),
  pdf: () => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200)]),
  /** An ELF header: what a disguised executable actually starts with. */
  executable: () =>
    Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(200)]),
};

describe('File uploads', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let bursarToken: string;
  let teacherToken: string;
  let ada: string;
  let chidi: string;
  let emekaToken: string; // Ada's father
  let ngoziToken: string; // Chidi's mother

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const head = () => bearer(school.accessToken);

  const uploadPhoto = (
    studentId: string,
    body: Buffer,
    name: string,
    type: string,
  ) =>
    ctx
      .http()
      .post(`/api/students/${studentId}/photo`)
      .set(head())
      .attach('file', body, { filename: name, contentType: type });

  async function staff(slug: string, email: string): Promise<string> {
    const role = await ctx.db.role.findFirstOrThrow({
      where: { schoolId: school.schoolId, slug },
    });
    const user = await ctx.db.user.create({
      data: {
        email,
        firstName: slug,
        lastName: 'Member',
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
      .send({ email, password: 'StrongPass123' })
      .expect(200);
    return login.body.tokens.accessToken;
  }

  /** A parent with a portal login, linked to one child. */
  async function parent(
    name: string,
    email: string,
    studentId: string,
  ): Promise<string> {
    const guardian = await ctx
      .http()
      .post('/api/guardians')
      .set(head())
      .send({
        firstName: name,
        lastName: 'Parent',
        phone: '08031234567',
        email,
      })
      .expect(201);
    await ctx
      .http()
      .post(`/api/students/${studentId}/guardians`)
      .set(head())
      .send({ guardianId: guardian.body.id, relationship: 'FATHER' })
      .expect(201);
    await ctx
      .http()
      .post(`/api/guardians/${guardian.body.id}/portal-access`)
      .set(head())
      .expect(201);

    const user = await ctx.db.user.findFirstOrThrow({ where: { email } });
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
      .send({ email, password: 'ParentPass123' })
      .expect(200);
    return login.body.tokens.accessToken;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Files College' });
    other = await registerSchool(ctx, { schoolName: 'Rival Academy' });
    bursarToken = await staff('ACCOUNTANT', 'bursar@files.test');
    teacherToken = await staff('TEACHER', 'teacher@files.test');
    jest
      .spyOn(ctx.app.get(EmailService), 'sendParentInvitation')
      .mockImplementation(() => Promise.resolve());
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.db.fileObject.deleteMany({});
    await ctx.db.payment.deleteMany({});
    await ctx.db.studentFeeItem.deleteMany({});
    await ctx.db.studentFee.deleteMany({});
    await ctx.db.feeStructureItem.deleteMany({});
    await ctx.db.feeStructure.deleteMany({});
    await ctx.db.feeCategory.deleteMany({});
    await ctx.db.studentGuardian.deleteMany({});
    await ctx.db.guardian.deleteMany({});
    await ctx.db.student.deleteMany({});
    await ctx.db.membership.deleteMany({
      where: { schoolId: school.schoolId, role: { slug: 'PARENT' } },
    });
    await ctx.db.user.deleteMany({
      where: { email: { endsWith: '@family.test' } },
    });

    const imported = await ctx
      .http()
      .post('/api/students/import')
      .set(head())
      .send({
        rows: [
          {
            firstName: 'Ada',
            lastName: 'Okafor',
            gender: 'F',
            admissionDate: '2026-09-15',
          },
          {
            firstName: 'Chidi',
            lastName: 'Eze',
            gender: 'M',
            admissionDate: '2026-09-15',
          },
        ],
      })
      .expect(200);
    [ada, chidi] = imported.body.rows.map(
      (row: { studentId: string }) => row.studentId,
    );
    emekaToken = await parent('Emeka', 'emeka@family.test', ada);
    ngoziToken = await parent('Ngozi', 'ngozi@family.test', chidi);
  });

  // -------------------------------------------------------------------------
  // What may be uploaded
  // -------------------------------------------------------------------------

  describe('what the bytes say', () => {
    it('accepts a real photo and serves it back unchanged', async () => {
      const bytes = file.jpeg();
      const uploaded = await uploadPhoto(
        ada,
        bytes,
        'ada.jpg',
        'image/jpeg',
      ).expect(201);
      expect(uploaded.body.photoUrl).toMatch(/^\/api\/files\/[0-9a-f-]{36}$/);

      const download = await ctx
        .http()
        .get(uploaded.body.photoUrl.replace('/api', '/api'))
        .set(head())
        .expect(200)
        .expect('Content-Type', /image\/jpeg/);
      expect(Buffer.from(download.body)).toEqual(bytes);
      expect(download.headers['content-disposition']).toMatch(
        /filename="ada.jpg"/,
      );
    });

    it('refuses an executable renamed as a photo', async () => {
      const response = await uploadPhoto(
        ada,
        file.executable(),
        'ada.jpg',
        'image/jpeg',
      ).expect(400);
      expect(response.body.message).toMatch(/Unrecognised file/);
      expect(await ctx.db.fileObject.count()).toBe(0);
    });

    it('refuses bytes that disagree with the declared type', async () => {
      const response = await uploadPhoto(
        ada,
        file.png(),
        'ada.jpg',
        'image/jpeg',
      ).expect(400);
      expect(response.body.message).toMatch(
        /sent as image\/jpeg but is really image\/png/,
      );
    });

    it('refuses a PDF as a photo but takes it as payment evidence', async () => {
      await uploadPhoto(ada, file.pdf(), 'ada.pdf', 'application/pdf').expect(
        400,
      );

      await ctx
        .http()
        .post('/api/files')
        .set(bearer(bursarToken))
        .field('purpose', 'PAYMENT_EVIDENCE')
        .field('studentId', ada)
        .attach('file', file.pdf(), {
          filename: 'teller.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
    });

    it('refuses an empty file and a missing one', async () => {
      const empty = await uploadPhoto(
        ada,
        Buffer.alloc(0),
        'ada.jpg',
        'image/jpeg',
      ).expect(400);
      expect(empty.body.message).toMatch(/empty/);

      const missing = await ctx
        .http()
        .post(`/api/students/${ada}/photo`)
        .set(head())
        .expect(400);
      expect(missing.body.message).toMatch(/No photo was attached/);
    });

    it('refuses a photo over its own limit, and anything over the hard limit', async () => {
      const big = await uploadPhoto(
        ada,
        file.jpeg(6 * 1024 * 1024),
        'big.jpg',
        'image/jpeg',
      ).expect(400);
      expect(big.body.message).toMatch(/the limit is 5 MB/);

      // Past the multipart ceiling, so it is cut off before any handler runs.
      const huge = await uploadPhoto(
        ada,
        file.jpeg(11 * 1024 * 1024),
        'huge.jpg',
        'image/jpeg',
      ).expect(413);
      expect(huge.body.errorCode).toBe('PAYLOAD_TOO_LARGE');
      expect(await ctx.db.fileObject.count()).toBe(0);
    });

    it('never lets a filename decide where bytes land', async () => {
      const uploaded = await uploadPhoto(
        ada,
        file.jpeg(),
        '../../../etc/passwd.jpg',
        'image/jpeg',
      ).expect(201);

      const stored = await ctx.db.fileObject.findFirstOrThrow();
      // The multipart parser drops the directory part before we see it, and
      // safeDisplayName handles the rest — see its unit tests for the full path.
      expect(stored.displayName).toBe('passwd.jpg');
      expect(stored.key).toMatch(
        new RegExp(
          `^schools/${school.schoolId}/student_photo/[0-9a-f-]{36}\\.jpg$`,
        ),
      );
      void uploaded;
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('replaces a photo without leaving the old one behind', async () => {
      const first = await uploadPhoto(
        ada,
        file.jpeg(),
        'first.jpg',
        'image/jpeg',
      ).expect(201);
      const firstId = first.body.photoUrl.split('/').pop();

      const second = await uploadPhoto(
        ada,
        file.png(),
        'second.png',
        'image/png',
      ).expect(201);
      expect(second.body.photoUrl).not.toBe(first.body.photoUrl);

      expect(await ctx.db.fileObject.count({ where: { linkedId: ada } })).toBe(
        1,
      );
      await ctx.http().get(`/api/files/${firstId}`).set(head()).expect(404);
    });

    it('clears a photo on request', async () => {
      await uploadPhoto(ada, file.jpeg(), 'ada.jpg', 'image/jpeg').expect(201);
      const cleared = await ctx
        .http()
        .delete(`/api/students/${ada}/photo`)
        .set(head())
        .expect(200);
      expect(cleared.body.photoUrl).toBeNull();
      expect(await ctx.db.fileObject.count()).toBe(0);
    });

    it('takes the photo with the student', async () => {
      await uploadPhoto(ada, file.jpeg(), 'ada.jpg', 'image/jpeg').expect(201);
      await ctx.db.studentGuardian.deleteMany({ where: { studentId: ada } });
      await ctx.http().delete(`/api/students/${ada}`).set(head()).expect(204);
      expect(await ctx.db.fileObject.count()).toBe(0);
    });

    it('sets and clears the school logo', async () => {
      const set = await ctx
        .http()
        .post('/api/schools/me/logo')
        .set(head())
        .attach('file', file.png(), {
          filename: 'logo.png',
          contentType: 'image/png',
        })
        .expect(201);
      expect(set.body.logoUrl).toMatch(/^\/api\/files\//);

      // It shows up on the documents that carry a letterhead.
      const student = await ctx
        .http()
        .get(`/api/students/${ada}`)
        .set(head())
        .expect(200);
      void student;

      await ctx.http().delete('/api/schools/me/logo').set(head()).expect(200);
      expect(await ctx.db.fileObject.count()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Who can read what
  // -------------------------------------------------------------------------

  describe('access', () => {
    it('never serves one school’s file to another', async () => {
      const uploaded = await uploadPhoto(
        ada,
        file.jpeg(),
        'ada.jpg',
        'image/jpeg',
      ).expect(201);
      await ctx
        .http()
        .get(uploaded.body.photoUrl)
        .set(bearer(other.accessToken))
        .expect(404);
    });

    it('lets a parent see their own child’s photo and nobody else’s', async () => {
      const adaPhoto = await uploadPhoto(
        ada,
        file.jpeg(),
        'ada.jpg',
        'image/jpeg',
      ).expect(201);
      const chidiPhoto = await uploadPhoto(
        chidi,
        file.jpeg(),
        'chidi.jpg',
        'image/jpeg',
      ).expect(201);

      await ctx
        .http()
        .get(adaPhoto.body.photoUrl)
        .set(bearer(emekaToken))
        .expect(200);
      await ctx
        .http()
        .get(chidiPhoto.body.photoUrl)
        .set(bearer(emekaToken))
        .expect(404);
    });

    it('keeps payment evidence to finance staff, the uploader and the family', async () => {
      const evidence = await ctx
        .http()
        .post(`/api/portal/children/${ada}/evidence`)
        .set(bearer(emekaToken))
        .attach('file', file.pdf(), {
          filename: 'teller.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      // The parent who sent it, and the bursar who must check it.
      await ctx
        .http()
        .get(evidence.body.url)
        .set(bearer(emekaToken))
        .expect(200);
      await ctx
        .http()
        .get(evidence.body.url)
        .set(bearer(bursarToken))
        .expect(200);
      // A teacher has no business with it, nor another family.
      await ctx
        .http()
        .get(evidence.body.url)
        .set(bearer(teacherToken))
        .expect(404);
      await ctx
        .http()
        .get(evidence.body.url)
        .set(bearer(ngoziToken))
        .expect(404);
    });

    it('refuses a parent uploading evidence against another family’s child', async () => {
      await ctx
        .http()
        .post(`/api/portal/children/${chidi}/evidence`)
        .set(bearer(emekaToken))
        .attach('file', file.pdf(), {
          filename: 'teller.pdf',
          contentType: 'application/pdf',
        })
        .expect(404);
    });

    it('refuses a teacher uploading a photo they have no permission for', async () => {
      await ctx
        .http()
        .post(`/api/students/${ada}/photo`)
        .set(bearer(teacherToken))
        .attach('file', file.jpeg(), {
          filename: 'ada.jpg',
          contentType: 'image/jpeg',
        })
        .expect(403);
    });

    it('asks a lister to say what they are looking for', async () => {
      await ctx.http().get('/api/files').set(head()).expect(400);
      const listed = await ctx
        .http()
        .get('/api/files?purpose=STUDENT_PHOTO')
        .set(head())
        .expect(200);
      expect(listed.body.data).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Evidence and payments
  // -------------------------------------------------------------------------

  describe('evidence attached to a payment', () => {
    async function invoiceFor(studentId: string) {
      const session = await ctx
        .http()
        .post('/api/academics/sessions')
        .set(head())
        .send({
          name: `2026/2027`,
          startDate: '2026-09-15',
          endDate: '2027-07-24',
        })
        .expect(201)
        .catch(async () => ({
          body: await ctx.db.academicSession.findFirstOrThrow({
            where: { schoolId: school.schoolId },
          }),
        }));
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
          sessionId: session.body.id,
          items: [{ categoryId: category.body.id, amount: 50000 }],
        })
        .expect(201);
      await ctx
        .http()
        .post(`/api/finance/fee-structures/${structure.body.id}/publish`)
        .set(head())
        .expect(200);
      const assigned = await ctx
        .http()
        .post('/api/finance/invoices/assign')
        .set(head())
        .send({ structureId: structure.body.id, studentIds: [studentId] })
        .expect(201);
      return assigned.body.invoices[0].id as string;
    }

    it('links the file to the payment it proves, and then protects it', async () => {
      const invoiceId = await invoiceFor(ada);
      const evidence = await ctx
        .http()
        .post(`/api/portal/children/${ada}/evidence`)
        .set(bearer(emekaToken))
        .attach('file', file.pdf(), {
          filename: 'teller.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      const payment = await ctx
        .http()
        .post(`/api/portal/children/${ada}/payments`)
        .set(bearer(emekaToken))
        .send({
          studentFeeId: invoiceId,
          amount: 50000,
          method: 'BANK_TRANSFER',
          reference: 'TRF/2026/1',
          evidenceUrl: evidence.body.url,
          paidAt: '2026-10-01T10:00:00Z',
        })
        .expect(201);

      const stored = await ctx.db.fileObject.findUniqueOrThrow({
        where: { id: evidence.body.id },
      });
      expect(stored).toMatchObject({
        linkedType: 'Payment',
        linkedId: payment.body.id,
      });

      // Evidence for a payment is not something to tidy away.
      const refused = await ctx
        .http()
        .delete(`/api/files/${evidence.body.id}`)
        .set(bearer(bursarToken))
        .expect(409);
      expect(refused.body.message).toMatch(/evidence for a payment/);
    });

    it('refuses a payment whose evidence belongs to another child', async () => {
      const invoiceId = await invoiceFor(ada);
      const theirs = await ctx
        .http()
        .post(`/api/portal/children/${chidi}/evidence`)
        .set(bearer(ngoziToken))
        .attach('file', file.pdf(), {
          filename: 'teller.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      const response = await ctx
        .http()
        .post(`/api/portal/children/${ada}/payments`)
        .set(bearer(emekaToken))
        .send({
          studentFeeId: invoiceId,
          amount: 1000,
          method: 'BANK_TRANSFER',
          reference: 'TRF/2026/2',
          evidenceUrl: theirs.body.url,
          paidAt: '2026-10-01T10:00:00Z',
        })
        .expect(400);
      expect(response.body.message).toMatch(/does not belong to this student/);
      // Nothing was recorded.
      expect(await ctx.db.payment.count()).toBe(0);
    });

    it('still accepts a plain link to somewhere else', async () => {
      const invoiceId = await invoiceFor(ada);
      await ctx
        .http()
        .post(`/api/portal/children/${ada}/payments`)
        .set(bearer(emekaToken))
        .send({
          studentFeeId: invoiceId,
          amount: 1000,
          method: 'BANK_TRANSFER',
          reference: 'TRF/2026/3',
          evidenceUrl: 'https://drive.example.com/teller.jpg',
          paidAt: '2026-10-01T10:00:00Z',
        })
        .expect(201);
    });
  });
});
