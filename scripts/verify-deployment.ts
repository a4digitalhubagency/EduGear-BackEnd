/**
 * Checks a deployed environment from outside, with no credentials.
 *
 *   npm run verify:deploy -- https://edugear-backend-production.up.railway.app production
 *   npm run verify:deploy -- https://edugear-backend-staging.up.railway.app staging
 *
 * **Why this exists.** Railway's dashboard is authoritative for deploy
 * settings, and the repo only records them — which means the record and the
 * reality can disagree and nothing says so. That has already happened once:
 * the config was ignored on the first service, so `prisma migrate deploy`
 * silently never ran, and with the healthcheck also unset every broken deploy
 * still reported success. A dashboard showing the right values is not evidence
 * that the right values are in force.
 *
 * So this asks the running process instead. Everything here is a plain
 * unauthenticated GET against the service's own public URL — the same requests
 * anyone on the internet can make — and each one checks a specific
 * configuration mistake that is otherwise invisible until a school finds it.
 *
 * It deliberately does **not** read the Railway API or use the Railway CLI: the
 * account carries other organisations' work, so nothing here needs to be
 * trusted with it.
 *
 * Exit code 0 when every check passed, 1 otherwise, so CI could run it against
 * a deployed environment later if that is ever wanted.
 */

/** A single check's outcome. `warn` is "look at this", not "this is broken". */
type Level = 'pass' | 'warn' | 'fail';

interface Result {
  level: Level;
  title: string;
  detail: string;
}

const results: Result[] = [];

function record(level: Level, title: string, detail: string): void {
  results.push({ level, title, detail });
}

interface Fetched {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

/**
 * One request, with the failure modes flattened into a value.
 *
 * A deployment that is down, asleep or refusing connections should produce a
 * readable line rather than an unhandled rejection twelve frames deep.
 */
async function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<Fetched | null> {
  try {
    const response = await fetch(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON — fine. Some of these checks are about HTML or an empty body.
    }
    return { status: response.status, headers: response.headers, body, text };
  } catch (error) {
    record('fail', `GET ${url}`, explain(error));
    return null;
  }
}

/**
 * Node's `fetch` reports every connection problem as "fetch failed" and hides
 * the reason in `cause`. The reason is the whole message: ENOTFOUND is a wrong
 * URL, ECONNREFUSED is a service that is not listening, and a timeout is one
 * that is asleep. Those call for three different next steps.
 */
function explain(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const cause = (error as { cause?: unknown }).cause;
  const causeMessage =
    cause instanceof Error
      ? (cause as { code?: string }).code
        ? `${(cause as { code?: string }).code}: ${cause.message}`
        : cause.message
      : undefined;

  if (error.name === 'TimeoutError') return 'timed out after 15s';
  return causeMessage ? `${error.message} (${causeMessage})` : error.message;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** `{ database: { status: 'up' } }` → `'up'`, whatever is missing on the way. */
function indicatorStatus(body: unknown, name: string): string | null {
  const info = asRecord(asRecord(body).info);
  const details = asRecord(asRecord(body).details);
  const entry = asRecord(info[name] ?? details[name]);
  return typeof entry.status === 'string' ? entry.status : null;
}

function report(): void {
  const width = Math.max(...results.map((result) => result.title.length));
  const mark: Record<Level, string> = {
    pass: '  ok  ',
    warn: ' warn ',
    fail: ' FAIL ',
  };

  console.log();
  for (const result of results) {
    console.log(
      `[${mark[result.level]}] ${result.title.padEnd(width)}  ${result.detail}`,
    );
  }
  console.log();
}

async function main(): Promise<void> {
  const [rawUrl, rawEnv, rawOrigin] = process.argv.slice(2);

  if (!rawUrl) {
    console.error(
      '\nUsage: npm run verify:deploy -- <base URL> [production|staging] ' +
        '[front-end origin]\n\n' +
        '  e.g. npm run verify:deploy -- https://api.edugear.ng production ' +
        'https://www.edugear.ng\n',
    );
    process.exit(1);
  }

  const base = rawUrl.replace(/\/+$/, '');
  const expectedEnv = rawEnv?.trim().toLowerCase();
  const frontEnd = rawOrigin?.trim().replace(/\/+$/, '');

  // Without an environment argument this is somebody pointing it at a local
  // build or a preview. Several checks only have a right answer relative to a
  // named deployment, so they soften rather than guess.
  const deployed = Boolean(expectedEnv);

  if (expectedEnv && !['production', 'staging'].includes(expectedEnv)) {
    console.error(`\nUnknown environment "${rawEnv}".\n`);
    process.exit(1);
  }

  console.log(
    `\nVerifying ${base}${expectedEnv ? ` as ${expectedEnv}` : ''}\n`,
  );

  // ---------------------------------------------------------------------------
  // Health: the database, and the cache that production cannot run without.
  // ---------------------------------------------------------------------------

  const health = await get(`${base}/api/health`);

  // Nothing below can mean anything if the service is not reachable, and six
  // copies of the same DNS error is not a report.
  if (!health) {
    report();
    console.log(
      'Could not reach the service, so nothing else was checked. Verify the ' +
        'URL, and that the deployment is active.\n',
    );
    process.exit(1);
  }

  {
    if (health.status === 200) {
      record('pass', 'Health', 'answers 200');
    } else {
      record('fail', 'Health', `answers ${health.status} — expected 200`);
    }

    const database = indicatorStatus(health.body, 'database');
    record(
      database === 'up' ? 'pass' : 'fail',
      'Database',
      database ? `reports "${database}"` : 'not reported at all',
    );

    // Absent rather than down is the tell: RedisService only probes when
    // REDIS_URL is set, so a missing cache indicator means the variable is
    // missing. Under NODE_ENV=production that should have failed the boot —
    // so if the service is answering *and* has no cache, NODE_ENV is wrong.
    const cache = indicatorStatus(health.body, 'cache');
    if (cache === 'up') {
      record('pass', 'Cache (Redis)', 'reports "up"');
    } else if (cache === null) {
      record(
        'fail',
        'Cache (Redis)',
        'not reported — REDIS_URL is unset, so rate limiting and the ' +
          'permission cache are per-instance. Production refuses to boot ' +
          'without it, so NODE_ENV is probably not "production" here either',
      );
    } else {
      record('fail', 'Cache (Redis)', `reports "${cache}"`);
    }
  }

  // ---------------------------------------------------------------------------
  // Which build, and which deployment it thinks it is.
  // ---------------------------------------------------------------------------

  const live = await get(`${base}/api/health/live`);
  if (live) {
    const body = asRecord(live.body);
    const version = typeof body.version === 'string' ? body.version : null;
    const environment =
      typeof body.environment === 'string' ? body.environment : null;

    // The APP_VERSION trap. `${{RAILWAY_GIT_COMMIT_SHA}}` expands to an empty
    // string, so the variable has to be left unset for validateEnv to read the
    // platform's own build variable. "unset" here means it was set to nothing,
    // or the deploy is not git-sourced — and either way Sentry has no release.
    if (version && version !== 'unset') {
      record('pass', 'Deployed commit', `reports ${version}`);
    } else if (!deployed) {
      // A local `node dist/main` has no build variable to fall back to, so
      // "unset" is the only possible answer and says nothing about Railway.
      record(
        'warn',
        'Deployed commit',
        'reports "unset" — expected outside a deployment',
      );
    } else {
      record(
        'fail',
        'Deployed commit',
        'reports "unset" — either APP_VERSION is set to an empty value ' +
          "(Railway's ${{…}} syntax does that) or the deploy is not " +
          'git-sourced. Sentry errors will carry no release',
      );
    }

    if (!environment) {
      record('fail', 'APP_ENV', 'not reported');
    } else if (!expectedEnv) {
      record(
        'warn',
        'APP_ENV',
        `reports "${environment}" — nothing to compare`,
      );
    } else if (environment === expectedEnv) {
      record('pass', 'APP_ENV', `reports "${environment}"`);
    } else {
      record(
        'fail',
        'APP_ENV',
        `reports "${environment}" but this should be "${expectedEnv}". ` +
          'This names the deployment for Sentry and the seed guard; staging ' +
          'runs NODE_ENV=production, so APP_ENV is the only thing that ' +
          'distinguishes them',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // The API surface: closed in production, usually open in staging.
  // ---------------------------------------------------------------------------

  const docs = await get(`${base}/api/docs`);
  if (docs) {
    const published = docs.status === 200 || docs.status === 301;
    if (expectedEnv === 'production') {
      record(
        published ? 'fail' : 'pass',
        'Swagger',
        published
          ? `published (${docs.status}) — SWAGGER_ENABLED must be absent or ` +
              'false in production'
          : `closed (${docs.status})`,
      );
    } else {
      record(
        published ? 'pass' : 'warn',
        'Swagger',
        published
          ? `published (${docs.status})`
          : `closed (${docs.status}) — staging runs NODE_ENV=production, so ` +
              'SWAGGER_ENABLED must be explicitly true for the docs to appear',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Authentication actually guards things.
  // ---------------------------------------------------------------------------

  const guarded = await get(`${base}/api/students`);
  if (guarded) {
    record(
      guarded.status === 401 ? 'pass' : 'fail',
      'Authentication',
      `an unauthenticated school route answers ${guarded.status}` +
        (guarded.status === 401 ? '' : ' — expected 401'),
    );
  }

  const platform = await get(`${base}/api/platform/schools`);
  if (platform) {
    record(
      platform.status === 401 ? 'pass' : 'fail',
      'Platform surface',
      `an unauthenticated platform route answers ${platform.status}` +
        (platform.status === 401 ? '' : ' — expected 401'),
    );
  }

  // ---------------------------------------------------------------------------
  // CORS, which is a variable and therefore a per-environment mistake.
  // ---------------------------------------------------------------------------

  const stranger = await get(`${base}/api/health`, {
    Origin: 'https://not-edugear.example',
  });
  if (stranger) {
    const allowed = stranger.headers.get('access-control-allow-origin');
    if (allowed === '*') {
      record(
        'fail',
        'CORS',
        'echoes "*" — any site can call this API with a browser session',
      );
    } else if (allowed === 'https://not-edugear.example') {
      record(
        'fail',
        'CORS',
        'reflected an origin it should not know. CORS_ORIGINS is too broad',
      );
    } else {
      record(
        'pass',
        'CORS (stranger)',
        'an unknown origin is not allowed' + (allowed ? ` (${allowed})` : ''),
      );
    }
  }

  // The likelier mistake, and the one the negative check above cannot see: a
  // CORS_ORIGINS that is simply wrong, so the real front end is refused and
  // every screen fails in the browser while curl reports a healthy API.
  if (frontEnd) {
    const own = await get(`${base}/api/health`, { Origin: frontEnd });
    if (own) {
      const allowed = own.headers.get('access-control-allow-origin');
      if (allowed === frontEnd) {
        record('pass', 'CORS (front end)', `${frontEnd} is allowed`);
      } else {
        record(
          'fail',
          'CORS (front end)',
          `${frontEnd} is NOT allowed` +
            (allowed
              ? ` — the header said "${allowed}"`
              : ' — no header at all') +
            '. Every browser request from the front end will fail while the ' +
            'API itself looks healthy. Check CORS_ORIGINS for this environment',
        );
      }
    }
  } else if (deployed) {
    record(
      'warn',
      'CORS (front end)',
      'not checked — pass the front-end origin as a third argument to ' +
        'confirm CORS_ORIGINS actually permits it',
    );
  }

  // ---------------------------------------------------------------------------
  // Transport.
  // ---------------------------------------------------------------------------

  {
    const hsts = health.headers.get('strict-transport-security');
    record(
      hsts ? 'pass' : 'warn',
      'Security headers',
      hsts ? `HSTS present (${hsts})` : 'no HSTS header — is helmet running?',
    );
  }

  // ---------------------------------------------------------------------------

  report();

  const failures = results.filter((r) => r.level === 'fail').length;
  const warnings = results.filter((r) => r.level === 'warn').length;

  if (failures > 0) {
    console.log(
      `${failures} check(s) failed${warnings ? `, ${warnings} warning(s)` : ''}.\n`,
    );
    process.exit(1);
  }
  console.log(
    `All checks passed${warnings ? `, with ${warnings} warning(s)` : ''}.\n`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
