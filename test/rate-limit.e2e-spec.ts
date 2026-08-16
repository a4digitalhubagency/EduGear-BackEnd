/**
 * Rate limiting has its own suite because it needs its own limits. The env vars
 * are set before `test-app` is required, so the throttle constants (read at
 * module load, as decorators demand) pick them up.
 */
process.env.AUTH_THROTTLE_LIMIT = '3';
process.env.AUTH_THROTTLE_TTL_SECONDS = '60';
process.env.STRICT_THROTTLE_LIMIT = '2';
process.env.STRICT_THROTTLE_TTL_SECONDS = '3600';

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
