import {
  closeTestApp,
  createTestApp,
  registerSchool,
  RegisteredSchool,
  resetDatabase,
  TestContext,
} from './utils/test-app';

describe('Guardians', () => {
  let ctx: TestContext;
  let school: RegisteredSchool;
  let other: RegisteredSchool;
  let studentId: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const auth = () => bearer(school.accessToken);

  const createGuardian = (overrides: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post('/api/guardians')
      .set(auth())
      .send({
        firstName: 'Emeka',
        lastName: 'Obi',
        phone: '08031234567',
        ...overrides,
      });

  const link = (guardianId: string, overrides: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post(`/api/students/${studentId}/guardians`)
      .set(auth())
      .send({ guardianId, relationship: 'FATHER', ...overrides });

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
    school = await registerSchool(ctx, { schoolName: 'Guardians College' });
    other = await registerSchool(ctx, { schoolName: 'Rival Academy' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.db.studentGuardian.deleteMany({});
    await ctx.db.guardian.deleteMany({});
    await ctx.db.student.deleteMany({});

    const student = await ctx
      .http()
      .post('/api/students')
      .set(auth())
      .send({
        firstName: 'Ada',
        lastName: 'Obi',
        gender: 'FEMALE',
        admissionDate: '2025-09-15',
      })
      .expect(201);
    studentId = student.body.id;
  });

  // -------------------------------------------------------------------------
  // Guardian records
  // -------------------------------------------------------------------------

  it('creates a guardian', async () => {
    const response = await createGuardian().expect(201);
    expect(response.body).toMatchObject({
      fullName: 'Emeka Obi',
      phone: '08031234567',
      wardCount: 0,
      hasPortalAccess: false,
    });
  });

  it('requires a phone number', async () => {
    await ctx
      .http()
      .post('/api/guardians')
      .set(auth())
      .send({ firstName: 'Emeka', lastName: 'Obi' })
      .expect(400);
  });

  it('rejects an invalid phone number', async () => {
    await createGuardian({ phone: '12345' }).expect(400);
  });

  it('rejects a duplicate email', async () => {
    await createGuardian({ email: 'emeka@example.com' }).expect(201);

    const response = await createGuardian({
      firstName: 'Other',
      email: 'EMEKA@example.com',
    }).expect(409);
    expect(response.body.errorCode).toBe('DUPLICATE_RESOURCE');
  });

  it('allows many guardians with no email', async () => {
    await createGuardian().expect(201);
    await createGuardian({ firstName: 'Ngozi' }).expect(201);

    const response = await ctx
      .http()
      .get('/api/guardians')
      .set(auth())
      .expect(200);
    expect(response.body.data).toHaveLength(2);
  });

  it('searches by name, phone and email', async () => {
    await createGuardian({
      firstName: 'Emeka',
      phone: '08031234567',
      email: 'emeka@example.com',
    }).expect(201);
    await createGuardian({
      firstName: 'Ngozi',
      lastName: 'Ade',
      phone: '08099998888',
    }).expect(201);

    const byName = await ctx
      .http()
      .get('/api/guardians?search=ngozi')
      .set(auth())
      .expect(200);
    expect(byName.body.data).toHaveLength(1);

    const byPhone = await ctx
      .http()
      .get('/api/guardians?search=0809999')
      .set(auth())
      .expect(200);
    expect(byPhone.body.data[0].firstName).toBe('Ngozi');

    const byEmail = await ctx
      .http()
      .get('/api/guardians?search=emeka@')
      .set(auth())
      .expect(200);
    expect(byEmail.body.data[0].firstName).toBe('Emeka');
  });

  it('updates a guardian', async () => {
    const guardian = await createGuardian().expect(201);

    const response = await ctx
      .http()
      .patch(`/api/guardians/${guardian.body.id}`)
      .set(auth())
      .send({ occupation: 'Trader', altPhone: '08131234567' })
      .expect(200);
    expect(response.body.occupation).toBe('Trader');
  });

  it('deletes an unlinked guardian', async () => {
    const guardian = await createGuardian().expect(201);

    await ctx
      .http()
      .delete(`/api/guardians/${guardian.body.id}`)
      .set(auth())
      .expect(204);
  });

  it('refuses to delete a guardian still linked to a student', async () => {
    const guardian = await createGuardian().expect(201);
    await link(guardian.body.id).expect(201);

    const response = await ctx
      .http()
      .delete(`/api/guardians/${guardian.body.id}`)
      .set(auth())
      .expect(409);
    expect(response.body.message).toMatch(/still linked to 1 student/);
  });

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  it('links a guardian to a student', async () => {
    const guardian = await createGuardian().expect(201);

    const response = await link(guardian.body.id, { isPrimary: true }).expect(
      201,
    );
    expect(response.body.wards).toHaveLength(1);
    expect(response.body.wards[0]).toMatchObject({
      studentId,
      admissionNumber: '2025/0001',
      fullName: 'Obi, Ada',
      relationship: 'FATHER',
      isPrimary: true,
      canPickUp: true,
    });
  });

  it('shows the guardian on the student profile', async () => {
    const guardian = await createGuardian().expect(201);
    await link(guardian.body.id, { isPrimary: true }).expect(201);

    const response = await ctx
      .http()
      .get(`/api/students/${studentId}`)
      .set(auth())
      .expect(200);
    expect(response.body.guardians).toHaveLength(1);
    expect(response.body.guardians[0]).toMatchObject({
      fullName: 'Emeka Obi',
      relationship: 'FATHER',
      isPrimary: true,
    });
  });

  it('rejects linking the same guardian twice', async () => {
    const guardian = await createGuardian().expect(201);
    await link(guardian.body.id).expect(201);

    await link(guardian.body.id, { relationship: 'GUARDIAN' }).expect(409);
  });

  it('keeps at most one primary guardian per student', async () => {
    const father = await createGuardian().expect(201);
    const mother = await createGuardian({ firstName: 'Ngozi' }).expect(201);

    await link(father.body.id, { isPrimary: true }).expect(201);
    await link(mother.body.id, {
      relationship: 'MOTHER',
      isPrimary: true,
    }).expect(201);

    const profile = await ctx
      .http()
      .get(`/api/students/${studentId}`)
      .set(auth())
      .expect(200);
    const primaries = profile.body.guardians.filter(
      (g: { isPrimary: boolean }) => g.isPrimary,
    );
    expect(primaries).toHaveLength(1);
    expect(primaries[0].fullName).toBe('Ngozi Obi');
  });

  it('promotes a guardian to primary through the link endpoint', async () => {
    const father = await createGuardian().expect(201);
    const mother = await createGuardian({ firstName: 'Ngozi' }).expect(201);
    await link(father.body.id, { isPrimary: true }).expect(201);
    await link(mother.body.id, { relationship: 'MOTHER' }).expect(201);

    await ctx
      .http()
      .patch(`/api/students/${studentId}/guardians/${mother.body.id}`)
      .set(auth())
      .send({ isPrimary: true })
      .expect(200);

    const profile = await ctx
      .http()
      .get(`/api/students/${studentId}`)
      .set(auth())
      .expect(200);
    const primaries = profile.body.guardians.filter(
      (g: { isPrimary: boolean }) => g.isPrimary,
    );
    expect(primaries).toHaveLength(1);
    expect(primaries[0].fullName).toBe('Ngozi Obi');
  });

  it('updates pickup permission on a link', async () => {
    const guardian = await createGuardian().expect(201);
    await link(guardian.body.id).expect(201);

    const response = await ctx
      .http()
      .patch(`/api/students/${studentId}/guardians/${guardian.body.id}`)
      .set(auth())
      .send({ canPickUp: false })
      .expect(200);
    expect(response.body.wards[0].canPickUp).toBe(false);
  });

  it('unlinks a guardian without deleting them', async () => {
    const guardian = await createGuardian().expect(201);
    await link(guardian.body.id).expect(201);

    await ctx
      .http()
      .delete(`/api/students/${studentId}/guardians/${guardian.body.id}`)
      .set(auth())
      .expect(204);

    const response = await ctx
      .http()
      .get(`/api/guardians/${guardian.body.id}`)
      .set(auth())
      .expect(200);
    expect(response.body.wards).toHaveLength(0);
  });

  it('404s when unlinking a link that does not exist', async () => {
    const guardian = await createGuardian().expect(201);

    await ctx
      .http()
      .delete(`/api/students/${studentId}/guardians/${guardian.body.id}`)
      .set(auth())
      .expect(404);
  });

  it('links one guardian to several students', async () => {
    const guardian = await createGuardian().expect(201);
    const sibling = await ctx
      .http()
      .post('/api/students')
      .set(auth())
      .send({
        firstName: 'Chidi',
        lastName: 'Obi',
        gender: 'MALE',
        admissionDate: '2025-09-15',
      })
      .expect(201);

    await link(guardian.body.id).expect(201);
    await ctx
      .http()
      .post(`/api/students/${sibling.body.id}/guardians`)
      .set(auth())
      .send({ guardianId: guardian.body.id, relationship: 'FATHER' })
      .expect(201);

    const response = await ctx
      .http()
      .get(`/api/guardians/${guardian.body.id}`)
      .set(auth())
      .expect(200);
    expect(response.body.wards).toHaveLength(2);
    expect(response.body.wardCount).toBe(2);
  });

  it('filters guardians by student', async () => {
    const linked = await createGuardian().expect(201);
    await createGuardian({ firstName: 'Unrelated' }).expect(201);
    await link(linked.body.id).expect(201);

    const response = await ctx
      .http()
      .get(`/api/guardians?studentId=${studentId}`)
      .set(auth())
      .expect(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].firstName).toBe('Emeka');
  });

  it('drops the link when the student is deleted', async () => {
    const guardian = await createGuardian().expect(201);
    await link(guardian.body.id).expect(201);

    await ctx
      .http()
      .delete(`/api/students/${studentId}`)
      .set(auth())
      .expect(204);

    const response = await ctx
      .http()
      .get(`/api/guardians/${guardian.body.id}`)
      .set(auth())
      .expect(200);
    expect(response.body.wards).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  it('never shows another school its neighbour’s guardians', async () => {
    await createGuardian().expect(201);

    const response = await ctx
      .http()
      .get('/api/guardians')
      .set(bearer(other.accessToken))
      .expect(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('refuses to link another school’s guardian', async () => {
    const guardian = await createGuardian().expect(201);

    // The guardian id is real, but it belongs to a different tenant.
    await ctx
      .http()
      .post(`/api/students/${studentId}/guardians`)
      .set(bearer(other.accessToken))
      .send({ guardianId: guardian.body.id, relationship: 'FATHER' })
      .expect(404);
  });

  it('lets two schools reuse a guardian email', async () => {
    await createGuardian({ email: 'shared@example.com' }).expect(201);

    await ctx
      .http()
      .post('/api/guardians')
      .set(bearer(other.accessToken))
      .send({
        firstName: 'Emeka',
        lastName: 'Rival',
        phone: '08031234567',
        email: 'shared@example.com',
      })
      .expect(201);
  });
});
