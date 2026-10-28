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

  describe('TRUSTED_PROXY_SECRET', () => {
    it('is optional', () => {
      expect(problemsFrom(valid)).toHaveLength(0);
    });

    it('treats a variable set to nothing as unset', () => {
      // How `VAR=` in a copied .env.example arrives. Refusing to boot on it
      // would make the safe choice — not using the header — the broken one.
      const config = validateEnv({ ...valid, TRUSTED_PROXY_SECRET: '   ' });
      expect(config.TRUSTED_PROXY_SECRET).toBeUndefined();
    });

    it('refuses a secret short enough to guess', () => {
      expect(
        problemsFrom({ ...valid, TRUSTED_PROXY_SECRET: 'tooshort' }).join('\n'),
      ).toMatch(/TRUSTED_PROXY_SECRET/);
    });

    it('accepts a long one, trimmed', () => {
      const config = validateEnv({
        ...valid,
        TRUSTED_PROXY_SECRET: ` ${'s'.repeat(40)} `,
      });
      expect(config.TRUSTED_PROXY_SECRET).toBe('s'.repeat(40));
    });
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

  it('catches a connection string that still carries its own key name', () => {
    // Exactly what a KEY=value block pasted into a dashboard value field looks
    // like. It is a non-empty string, so every other check passes, and it fails
    // at connect time instead — Redis quietly, leaving production cacheless.
    const problems = problemsFrom({
      ...valid,
      REDIS_URL: 'REDIS_URL=redis://localhost:6379',
    });
    expect(problems.join('\n')).toMatch(/paste the connection string only/);

    expect(
      problemsFrom({
        ...valid,
        DATABASE_URL: 'DATABASE_URL=postgresql://user:pass@host:5432/db',
      }).join('\n'),
    ).toMatch(/DATABASE_URL/);
  });

  it('rejects a connection string with the wrong scheme', () => {
    expect(
      problemsFrom({ ...valid, REDIS_URL: 'http://localhost:6379' }).join('\n'),
    ).toMatch(/must start with redis:\/\/ or rediss:\/\//);
    // rediss:// is TLS and must stay acceptable.
    expect(
      problemsFrom({ ...valid, REDIS_URL: 'rediss://host:6379' }),
    ).toHaveLength(0);
  });

  it('picks up the deployed commit from the platform when APP_VERSION is unset', () => {
    // Railway injects RAILWAY_GIT_COMMIT_SHA into the container, but its
    // ${{…}} reference syntax addresses other services' variables, not the
    // platform's own — so APP_VERSION=${{RAILWAY_GIT_COMMIT_SHA}} expands to
    // nothing and every Sentry error went out with no release.
    const sha = 'bc1ca25a3656ef9db15c30398fc0cb588d2e4c75';
    expect(
      validateEnv({ ...valid, RAILWAY_GIT_COMMIT_SHA: sha }).APP_VERSION,
    ).toBe(sha);

    // An explicit value still wins.
    expect(
      validateEnv({
        ...valid,
        APP_VERSION: 'v2.0.0',
        RAILWAY_GIT_COMMIT_SHA: sha,
      }).APP_VERSION,
    ).toBe('v2.0.0');

    // An unresolved reference is empty, which must not count as explicit.
    expect(
      validateEnv({ ...valid, APP_VERSION: '', RAILWAY_GIT_COMMIT_SHA: sha })
        .APP_VERSION,
    ).toBe(sha);

    // Nothing anywhere stays undefined rather than inventing a version.
    expect(validateEnv(valid).APP_VERSION).toBeUndefined();
  });

  it('keeps Swagger off in production unless asked for explicitly', () => {
    // A forgotten variable published the entire API surface — every endpoint,
    // every DTO, every validation rule — on the live service.
    expect(validateEnv(valid).SWAGGER_ENABLED).toBe(false);

    // An explicit value still wins, in either direction.
    expect(
      validateEnv({ ...valid, SWAGGER_ENABLED: 'true' }).SWAGGER_ENABLED,
    ).toBe(true);
    expect(
      validateEnv({ ...valid, SWAGGER_ENABLED: 'false' }).SWAGGER_ENABLED,
    ).toBe(false);

    // Development is unaffected: docs on by default is the point there.
    expect(
      validateEnv({
        NODE_ENV: NodeEnv.Development,
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        JWT_ACCESS_SECRET: 'a'.repeat(40),
      }).SWAGGER_ENABLED,
    ).toBe(true);
  });

  it('refuses to send real email to localhost links', () => {
    // The day EMAIL_PROVIDER flips to resend is the day FRONTEND_URL has to be
    // real, or parents get invitation links pointing at their own machine.
    const problems = problemsFrom({
      ...valid,
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test_key',
      FRONTEND_URL: 'http://localhost:5173',
    });
    expect(problems.join('\n')).toMatch(/FRONTEND_URL/);

    expect(
      problemsFrom({
        ...valid,
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_test_key',
        FRONTEND_URL: 'https://app.edugear.ng',
      }),
    ).toHaveLength(0);

    // Console email is for environments with no front end, so it stays allowed.
    expect(
      problemsFrom({ ...valid, FRONTEND_URL: 'http://localhost:5173' }),
    ).toHaveLength(0);
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
