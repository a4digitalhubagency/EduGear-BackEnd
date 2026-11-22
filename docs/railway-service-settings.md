# Railway service settings

Railway stops reading `railway.json` on **1 December 2026**. These settings
have to live in the Railway dashboard instead, entered by hand on the backend
service, **in both the `production` and `staging` environments**.

`.railway/railway.ts` is the typechecked record of the same values. The
dashboard is what actually runs; that file is what stops the record rotting.

## Why this is safe to do now

The values below are identical to what `railway.json` already contains. While
that file is still read it wins, so entering them changes nothing. On the day
it stops being read, these become the live configuration — with no window in
which the pre-deploy migration step or the healthcheck goes missing.

So: set them now, verify, and delete `railway.json` afterwards. Not the other
way round. Deleting the file first drops the settings on the next deploy.

## What to set

Railway → project `appealing-charisma` → service **EduGear-BackEnd** →
**Settings**. Repeat for each environment; the environment switcher is at the
top of the page, and settings do **not** carry across.

| Section | Setting | Value |
| --- | --- | --- |
| Build | Builder | `Dockerfile` |
| Build | Dockerfile Path | `Dockerfile` |
| Deploy | Start Command | `node dist/main` |
| Deploy | Pre-Deploy Command | `npx prisma migrate deploy` |
| Deploy | Healthcheck Path | `/api/health` |
| Deploy | Healthcheck Timeout | `60` |
| Deploy | Restart Policy | `On Failure` |
| Deploy | Restart Max Retries | `3` |
| Deploy | Replicas | `1` |

## Environment variables

Settings and Variables are different tabs, and the variables are where the
damage is. They are also **per environment**, and three of them must differ
between `staging` and `production` or the two deployments quietly behave as
each other.

### The ones that must differ

| Variable | `production` | `staging` |
| --- | --- | --- |
| `APP_ENV` | `production` | `staging` |
| `DATABASE_URL` | production Neon branch | staging Neon branch |
| `DIRECT_URL` | production Neon direct | staging Neon direct |
| `REDIS_URL` | production Redis | staging Redis |
| `CORS_ORIGINS` | `https://www.edugear.ng` | the staging front end's origin |
| `FRONTEND_URL` | `https://www.edugear.ng` | the staging front end |
| `APP_URL` | this service's production URL | this service's staging URL |
| `PAYSTACK_SECRET_KEY` | live key | test key |
| `PAYSTACK_CALLBACK_URL` | production front end's callback | staging's |

**`APP_ENV` is the one to get right.** Staging deliberately runs
`NODE_ENV=production` so it behaves like production, which means `NODE_ENV`
cannot tell the two apart — `APP_ENV` is what names the deployment. It drives
Sentry's environment tag and the seed guard, so getting it wrong tags staging
errors as production and lets `db:seed` refuse the environment it is meant to
allow. Two bugs have already come from this.

### The one that must be left blank

**`APP_VERSION` — do not set it.** Railway's `${{…}}` reference syntax
addresses *other services'* variables, not the platform's own runtime ones, so
`APP_VERSION=${{RAILWAY_GIT_COMMIT_SHA}}` expands silently to an empty string
and every Sentry error goes out with no release attached. Left unset,
`validateEnv` reads `RAILWAY_GIT_COMMIT_SHA` directly. `/api/health/live`
reporting a real sha rather than `unset` is the proof it worked.

### The one that is a trap in staging

**`SWAGGER_ENABLED`.** Because staging runs `NODE_ENV=production`, the default
resolves to `false` there too — so staging has no API docs unless it is set to
`true` explicitly. That default exists because a forgotten variable once
published the whole API surface on the live service, and it is worth keeping.
But if the front-end work depends on reading `/api/docs` against staging, that
variable has to be present and `true` in the `staging` environment, and absent
in `production`.

### What production refuses to boot without

`validateEnv` fails the deploy, listing everything wrong at once, if under
`NODE_ENV=production`:

- `REDIS_URL` is missing — without it rate limiting and the permission cache
  are per-instance, so a second replica silently weakens both;
- `CORS_ORIGINS` is `*`;
- `JWT_ACCESS_SECRET` still contains `replace-me`.

And regardless of environment, if `EMAIL_PROVIDER=resend` while `FRONTEND_URL`
still points at localhost — every invitation and reset link would be a link to
somebody's own machine.

A failed boot here is the system working. Read the deploy log: it names each
problem.

### The two that must exist before a school is onboarded

`TRUSTED_PROXY_SECRET` (at least 32 characters) and `R2_*`. Neither fails the
boot — rate limiting falls back to the socket address, and uploads refuse
rather than crash — so their absence shows up as behaviour, not as an error.

## Verifying the variables from outside

```bash
npm run verify:deploy -- https://<the service URL> production https://www.edugear.ng
npm run verify:deploy -- https://<the service URL> staging <staging front end>
```

The third argument is optional but worth passing: without it the script can
only prove CORS refuses a *stranger*, not that it permits the real front end —
and a wrong `CORS_ORIGINS` fails every screen in the browser while the API
itself looks perfectly healthy to `curl`.

Read-only. It checks what the dashboard cannot tell you: that the running
process agrees. See [scripts/verify-deployment.ts](../scripts/verify-deployment.ts).

### The two that matter most

**Pre-Deploy Command** is the release step that runs database migrations. It
runs between build and deploy, and a failure stops the deployment — which is
the point: a deploy whose migrations did not apply must not go live. If this is
missing, migrations silently never run and the application starts against a
schema that no longer matches it.

**Healthcheck Path** is what stops a deploy the app cannot serve from being
reported as successful. Both of these were absent from the first Railway
service, and together they produced exactly that failure: broken deploys that
all reported success.

## Verifying

After setting them, on each environment:

1. Trigger a deploy (an empty commit on the branch that environment tracks is
   enough — `main` for production, `develop` for staging).
2. In the deploy logs, confirm a **pre-deploy** step appears and that it runs
   `prisma migrate deploy`. "No pending migrations to apply" is a pass.
3. Confirm the deploy waits on the healthcheck before going active.
4. Confirm the app answers, with the script rather than by eye:

   ```bash
   npm run verify:deploy -- https://<the service URL> production https://www.edugear.ng
   npm run verify:deploy -- https://<the service URL> staging <staging front end>
   ```

   It checks the database and cache are up, that `/api/health/live` reports a
   real commit rather than `unset`, that `APP_ENV` matches the environment you
   meant, that Swagger is closed in production, that an unauthenticated route
   still answers 401, and that CORS refuses an origin it should not know.

Only once both environments pass should `railway.json` be deleted, in its own
commit.

## Afterwards

Changing any of these is now a dashboard action, not a commit. Keep
`.railway/railway.ts` in step when you change one, or the record stops being
worth having — `npm run typecheck:railway` only proves the field names are
real, not that they match what Railway is running.
