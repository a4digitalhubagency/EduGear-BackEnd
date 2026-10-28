/**
 * Rate limiting has its own suite because it needs its own limits. The env vars
 * are set before `test-app` is required, so the throttle constants (read at
 * module load, as decorators demand) pick them up.
 */
process.env.AUTH_THROTTLE_LIMIT = '3';
process.env.AUTH_THROTTLE_TTL_SECONDS = '60';
process.env.STRICT_THROTTLE_LIMIT = '2';
process.env.STRICT_THROTTLE_TTL_SECONDS = '3600';
process.env.TRUSTED_PROXY_SECRET = 'e2e-trusted-proxy-secret-at-least-32-chars';

const { closeTestApp, createTestApp, resetDatabase } =
  require('./utils/test-app') as typeof import('./utils/test-app');
type TestContext = import('./utils/test-app').TestContext;

describe('Rate limiting', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('blocks repeated login attempts from the same client', async () => {
    const ip = '203.0.113.10';
    const attempt = () =>
      ctx
        .http()
        .post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: 'nobody@example.com', password: 'WrongPass123' });

    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);

    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.errorCode).toBe('RATE_LIMITED');
  });

  it('counts each client separately', async () => {
    const other = await ctx
      .http()
      .post('/api/auth/login')
      .set('X-Forwarded-For', '203.0.113.99')
      .send({ email: 'nobody@example.com', password: 'WrongPass123' });

    expect(other.status).toBe(401);
  });

  // The web app calls this API from its own server, so every request shares one
  // address. Without a way to say who the request is really for, one busy
  // school spends the budget of every other.
  describe('behind the front end', () => {
    const SECRET = 'e2e-trusted-proxy-secret-at-least-32-chars';

    const login = (headers: Record<string, string>) =>
      ctx
        .http()
        .post('/api/auth/login')
        .set(headers)
        .send({ email: 'nobody@example.com', password: 'WrongPass123' });

    it('gives each real client its own budget when the secret matches', async () => {
      const shared = { 'X-Forwarded-For': '203.0.113.30' };
      const first = {
        ...shared,
        'X-Edge-Secret': SECRET,
        'X-Client-Ip': '198.51.100.1',
      };

      expect((await login(first)).status).toBe(401);
      expect((await login(first)).status).toBe(401);
      expect((await login(first)).status).toBe(401);
      expect((await login(first)).status).toBe(429);

      // Same front end, same socket address, different person: still welcome.
      const second = {
        ...shared,
        'X-Edge-Secret': SECRET,
        'X-Client-Ip': '198.51.100.2',
      };
      expect((await login(second)).status).toBe(401);
    });

    it('ignores a client address that arrives without the secret', async () => {
      const shared = { 'X-Forwarded-For': '203.0.113.50' };

      // A fresh claimed address every time. If the header were believed
      // without proof, this would be an unlimited supply of budgets.
      expect(
        (await login({ ...shared, 'X-Client-Ip': '198.51.100.11' })).status,
      ).toBe(401);
      expect(
        (await login({ ...shared, 'X-Client-Ip': '198.51.100.12' })).status,
      ).toBe(401);
      expect(
        (await login({ ...shared, 'X-Client-Ip': '198.51.100.13' })).status,
      ).toBe(401);
      expect(
        (await login({ ...shared, 'X-Client-Ip': '198.51.100.14' })).status,
      ).toBe(429);
    });

    it('ignores a client address offered with the wrong secret', async () => {
      const shared = {
        'X-Forwarded-For': '203.0.113.60',
        'X-Edge-Secret': 'not-the-secret-but-the-same-sort-of-length!',
      };

      expect(
        (await login({ ...shared, 'X-Client-Ip': '198.51.100.21' })).status,
      ).toBe(401);
      expect(
        (await login({ ...shared, 'X-Client-Ip': '198.51.100.22' })).status,
      ).toBe(401);
      expect(
        (await login({ ...shared, 'X-Client-Ip': '198.51.100.23' })).status,
      ).toBe(401);
      expect(
        (await login({ ...shared, 'X-Client-Ip': '198.51.100.24' })).status,
      ).toBe(429);
    });
  });

  it('applies a tighter budget to school registration', async () => {
    const ip = '203.0.113.20';
    const register = (suffix: string) =>
      ctx
        .http()
        .post('/api/auth/register-school')
        .set('X-Forwarded-For', ip)
        .send({
          schoolName: `Throttled School ${suffix}`,
          schoolEmail: `info-${suffix}@example.com`,
          firstName: 'Test',
          lastName: 'Owner',
          email: `owner-${suffix}@example.com`,
          password: 'StrongPass123',
        });

    expect((await register('a')).status).toBe(201);
    expect((await register('b')).status).toBe(201);
    expect((await register('c')).status).toBe(429);
  });
});
