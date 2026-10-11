import {
  AppEnv,
  EnvironmentConfigError,
  NodeEnv,
  validateEnv,
} from './env.validation';

const valid = {
  NODE_ENV: NodeEnv.Production,
  DATABASE_URL: 'postgresql://user:pass@host:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  REDIS_URL: 'redis://localhost:6379',
  CORS_ORIGINS: 'https://app.example.test',
};

const problemsFrom = (env: Record<string, unknown>): string[] => {
  try {
    validateEnv(env);
    return [];
  } catch (error) {
    if (error instanceof EnvironmentConfigError) return error.problems;
    throw error;
  }
};

describe('validateEnv', () => {
  it('accepts a complete production configuration', () => {
    expect(() => validateEnv(valid)).not.toThrow();
  });

  it('reports every problem at once, not the first one', () => {
    // The whole point: a deploy that tells you about DATABASE_URL, then only
    // after a rebuild mentions REDIS_URL, costs a cycle per problem.
    const problems = problemsFrom({ NODE_ENV: NodeEnv.Production });

    expect(problems.join('\n')).toMatch(/DATABASE_URL/);
    expect(problems.join('\n')).toMatch(/JWT_ACCESS_SECRET/);
    expect(problems.join('\n')).toMatch(/REDIS_URL/);
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it('still catches the production-only rules alongside missing values', () => {
    const problems = problemsFrom({
      ...valid,
      CORS_ORIGINS: '*',
      REDIS_URL: '',
      JWT_ACCESS_SECRET: 'replace-me-replace-me-replace-me-replace',
    });

    expect(problems.join('\n')).toMatch(/CORS_ORIGINS/);
    expect(problems.join('\n')).toMatch(/REDIS_URL/);
    expect(problems.join('\n')).toMatch(/placeholder/);
  });

  it('does not apply the production rules outside production', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: NodeEnv.Development,
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        JWT_ACCESS_SECRET: 'a'.repeat(40),
        CORS_ORIGINS: '*',
      }),
    ).not.toThrow();
  });

  it('requires a Resend key only when Resend is the provider', () => {
    expect(
      problemsFrom({ ...valid, EMAIL_PROVIDER: 'resend' }).join('\n'),
    ).toMatch(/RESEND_API_KEY/);
    expect(problemsFrom({ ...valid, EMAIL_PROVIDER: 'console' })).toHaveLength(
      0,
    );
  });

  it('accepts the three deployment names and rejects anything else', () => {
    for (const env of [AppEnv.Development, AppEnv.Staging, AppEnv.Production]) {
      expect(problemsFrom({ ...valid, APP_ENV: env })).toHaveLength(0);
    }
    expect(problemsFrom({ ...valid, APP_ENV: 'prod' }).join('\n')).toMatch(
      /APP_ENV/,
    );
  });
});
