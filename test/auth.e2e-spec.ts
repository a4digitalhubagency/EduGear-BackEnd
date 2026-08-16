import {
  closeTestApp,
  createTestApp,
  registerSchool,
  RegisteredSchool,
  resetDatabase,
  TestContext,
} from './utils/test-app';

describe('Authentication', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.db);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  describe('POST /auth/register-school', () => {
    it('creates the tenant, its roles and a proprietor session', async () => {
      const response = await ctx
        .http()
        .post('/api/auth/register-school')
        .send({
          schoolName: 'Bright Star College',
          schoolEmail: 'info@brightstar.test',
          schoolPhone: '08031234567',
          city: 'Ibadan',
          state: 'Oyo',
          firstName: 'Adebayo',
          lastName: 'Ogunleye',
          email: 'adebayo@brightstar.test',
          password: 'StrongPass123',
        })
        .expect(201);

      expect(response.body.tokens.accessToken).toEqual(expect.any(String));
      expect(response.body.tokens.refreshToken).toEqual(expect.any(String));
      expect(response.body.user.email).toBe('adebayo@brightstar.test');
      expect(response.body.activeSchool.roleSlug).toBe('PROPRIETOR');
      expect(response.body.permissions).toContain('students.create');

      // The tenant gets its own copy of every system role.
      const roles = await ctx.db.role.findMany({
        where: { schoolId: response.body.activeSchool.schoolId },
      });
      expect(roles).toHaveLength(6);

      // Passwords are never stored in the clear.
      const user = await ctx.db.user.findUnique({
        where: { email: 'adebayo@brightstar.test' },
      });
      expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user?.passwordHash).not.toContain('StrongPass123');
    });

    it('rejects a weak password', async () => {
      const response = await ctx
        .http()
        .post('/api/auth/register-school')
        .send({
          schoolName: 'Weak Pass School',
          schoolEmail: 'info@weak.test',
          firstName: 'Test',
          lastName: 'User',
          email: 'weak@weak.test',
          password: 'password123',
        })
        .expect(400);

      expect(response.body.errorCode).toBe('VALIDATION_ERROR');
    });

    it('rejects a malformed payload before any business logic runs', async () => {
      const response = await ctx
        .http()
        .post('/api/auth/register-school')
        .send({ schoolName: 'X', email: 'not-an-email', password: 'short' })
        .expect(400);

      expect(response.body.errorCode).toBe('VALIDATION_ERROR');
      expect(response.body.requestId).toEqual(expect.any(String));
      expect(await ctx.db.school.count()).toBe(0);
    });

    it('refuses to reuse an email that already has an account', async () => {
      const school = await registerSchool(ctx);
      const response = await ctx
        .http()
        .post('/api/auth/register-school')
        .send({
          schoolName: 'Second School',
          schoolEmail: 'info@second.test',
          firstName: 'Test',
          lastName: 'User',
          email: school.email,
          password: 'StrongPass123',
        })
        .expect(409);

      expect(response.body.errorCode).toBe('DUPLICATE_RESOURCE');
    });
  });

  describe('POST /auth/login', () => {
    let school: RegisteredSchool;

    beforeEach(async () => {
      school = await registerSchool(ctx);
    });

    it('signs in with valid credentials', async () => {
      const response = await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: school.email, password: school.password })
        .expect(200);

      expect(response.body.tokens.accessToken).toEqual(expect.any(String));
      expect(response.body.activeSchool.schoolId).toBe(school.schoolId);
    });

    it('gives the same answer for a wrong password and an unknown email', async () => {
      const wrongPassword = await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: school.email, password: 'WrongPass123' })
        .expect(401);

      const unknownEmail = await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: 'WrongPass123' })
        .expect(401);

      expect(wrongPassword.body.errorCode).toBe('INVALID_CREDENTIALS');
      expect(unknownEmail.body.errorCode).toBe('INVALID_CREDENTIALS');
      expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
    });

    it('locks the account after repeated failures', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await ctx
          .http()
          .post('/api/auth/login')
          .send({ email: school.email, password: 'WrongPass123' })
          .expect(401);
      }

      const response = await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: school.email, password: school.password })
        .expect(401);

      expect(response.body.errorCode).toBe('ACCOUNT_LOCKED');
    });

    it('records a successful login in the audit trail', async () => {
      await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: school.email, password: school.password })
        .expect(200);

      const entry = await ctx.db.auditLog.findFirst({
        where: { action: 'auth.login.succeeded', schoolId: school.schoolId },
      });
      expect(entry).not.toBeNull();
      expect(entry?.requestId).toEqual(expect.any(String));
    });
  });

  describe('Tokens', () => {
    let school: RegisteredSchool;

    beforeEach(async () => {
      school = await registerSchool(ctx);
    });

    it('rotates the refresh token and rejects the old one', async () => {
      const rotated = await ctx
        .http()
        .post('/api/auth/refresh')
        .send({ refreshToken: school.refreshToken })
        .expect(200);

      expect(rotated.body.accessToken).toEqual(expect.any(String));
      expect(rotated.body.refreshToken).not.toBe(school.refreshToken);

      const replay = await ctx
        .http()
        .post('/api/auth/refresh')
        .send({ refreshToken: school.refreshToken })
        .expect(401);

      expect(replay.body.errorCode).toBe('TOKEN_REUSED');

      // Reuse kills the whole family, including the token just issued.
      await ctx
        .http()
        .post('/api/auth/refresh')
        .send({ refreshToken: rotated.body.refreshToken })
        .expect(401);
    });

    it('rejects requests without a token', async () => {
      const response = await ctx.http().get('/api/auth/me').expect(401);
      expect(response.body.errorCode).toBe('UNAUTHENTICATED');
    });

    it('rejects a tampered token', async () => {
      const response = await ctx
        .http()
        .get('/api/auth/me')
        .set({ Authorization: `Bearer ${school.accessToken.slice(0, -4)}abcd` })
        .expect(401);

      expect(response.body.errorCode).toBe('UNAUTHENTICATED');
    });

    it('invalidates every session when the password changes', async () => {
      await ctx
        .http()
        .post('/api/auth/change-password')
        .set({ Authorization: `Bearer ${school.accessToken}` })
        .send({
          currentPassword: school.password,
          newPassword: 'BrandNewPass123',
        })
        .expect(200);

      const afterChange = await ctx
        .http()
        .get('/api/auth/me')
        .set({ Authorization: `Bearer ${school.accessToken}` })
        .expect(401);
      expect(afterChange.body.errorCode).toBe('TOKEN_INVALID');

      await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: school.email, password: 'BrandNewPass123' })
        .expect(200);
    });

    it('revokes a refresh token on logout', async () => {
      await ctx
        .http()
        .post('/api/auth/logout')
        .send({ refreshToken: school.refreshToken })
        .expect(200);
      await ctx
        .http()
        .post('/api/auth/refresh')
        .send({ refreshToken: school.refreshToken })
        .expect(401);
    });
  });

  describe('GET /auth/me', () => {
    it('returns the profile, active school and effective permissions', async () => {
      const school = await registerSchool(ctx);

      const response = await ctx
        .http()
        .get('/api/auth/me')
        .set({ Authorization: `Bearer ${school.accessToken}` })
        .expect(200);

      expect(response.body.user.email).toBe(school.email);
      expect(response.body.activeSchool.schoolId).toBe(school.schoolId);
      expect(response.body.memberships).toHaveLength(1);
      expect(response.body.permissions).toContain('school.read');
      // The response must never leak credential material.
      expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    });
  });

  describe('Password reset', () => {
    it('answers identically for known and unknown emails', async () => {
      const school = await registerSchool(ctx);

      const known = await ctx
        .http()
        .post('/api/auth/forgot-password')
        .send({ email: school.email })
        .expect(202);
      const unknown = await ctx
        .http()
        .post('/api/auth/forgot-password')
        .send({ email: 'ghost@example.com' })
        .expect(202);

      expect(known.body.message).toBe(unknown.body.message);

      const tokens = await ctx.db.verificationToken.findMany({
        where: { userId: school.userId, type: 'PASSWORD_RESET' },
      });
      expect(tokens).toHaveLength(1);
      // Only the hash is stored.
      expect(tokens[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('rejects an unknown reset token', async () => {
      const response = await ctx
        .http()
        .post('/api/auth/reset-password')
        .send({ token: 'not-a-real-token', password: 'BrandNewPass123' })
        .expect(400);

      expect(response.body.errorCode).toBe('TOKEN_INVALID');
    });
  });
});
