# Railway service settings

Railway stops reading `railway.json` on **1 December 2026**. These settings have
to live in the Railway dashboard instead, entered by hand on the backend
service, **in both the `production` and `staging` environments**.

`.railway/railway.ts` is the typechecked record of the same values. The
dashboard is what actually runs; that file is what stops the record rotting.

**Doing this now is safe.** The values below are identical to what
`railway.json` already contains, and while that file is still read it wins — so
entering them changes nothing today, and on the day it stops being read they
become the live configuration with no window in which the pre-deploy migration
step or the healthcheck goes missing.

Set them, verify, **then** delete `railway.json`. Not the other way round:
deleting the file first drops the settings on the next deploy.

---

## Before you start

- The Railway dashboard, at project `appealing-charisma` → service
  **EduGear-BackEnd**.
- The environment switcher is at the top of the page. **Nothing on either tab
  carries across environments** — everything below is done twice.
- A terminal in this repo, for the verification step at the end.
- About twenty minutes for both environments.

Work through it in order. Steps 1 and 2 are the two dashboard tabs; 3 repeats
them; 4 proves it; 5 cleans up.

---

## Step 1 — the Settings tab

Ten values. They are the same in both environments.

| Section | Setting | Value |
| --- | --- | --- |
| Build | Builder | `Dockerfile` |
| Build | Dockerfile Path | `Dockerfile` |
| Deploy | Start Command | `node dist/main` |
| Deploy | Pre-Deploy Command | `npx prisma migrate deploy` |
| Deploy | Pre-Deploy Timeout | `600` |
| Deploy | Healthcheck Path | `/api/health` |
| Deploy | Healthcheck Timeout | `60` |
| Deploy | Restart Policy | `On Failure` |
| Deploy | Restart Max Retries | `3` |
| Deploy | Replicas | `1` |

### The two that matter most

**Pre-Deploy Command** is the release step that runs database migrations. It
runs between build and deploy, and a failure stops the deployment — which is the
point: a deploy whose migrations did not apply must not go live. If it is
missing, migrations silently never run and the application starts against a
schema that no longer matches it.

**Pre-Deploy Timeout** is set long on purpose. Prisma wraps each migration in a
transaction, so a timeout rolls the SQL back cleanly — but it leaves that
migration marked *failed* in `_prisma_migrations`, and every later deploy then
refuses to start until somebody runs `prisma migrate resolve` by hand against
production. Ten minutes of waiting for a hung migration is a delayed deploy;
cutting one short is an outage that needs manual database surgery. The headroom
is not for today's migrations, which finish in seconds, but for an index added
to `students` or `payments` once a school has a hundred thousand rows.

**Healthcheck Path** is what stops a deploy the app cannot serve from being
reported as successful.

Both were absent from the first Railway service, and together they produced
exactly that failure: broken deploys that all reported success. If you only
check two things on this page, check these.

---

## Step 2 — the Variables tab

Settings and Variables are different tabs, and the variables are where the
damage is.

### The ones that must differ between environments

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
errors as production and makes `db:seed` refuse the environment it is meant to
allow. Two bugs have already come from this.

### The one that must be left blank

**`APP_VERSION` — do not set it.** Railway's `${{…}}` reference syntax addresses
*other services'* variables, not the platform's own runtime ones, so
`APP_VERSION=${{RAILWAY_GIT_COMMIT_SHA}}` expands silently to an empty string and
every Sentry error goes out with no release attached. Left unset, `validateEnv`
reads `RAILWAY_GIT_COMMIT_SHA` directly. `/api/health/live` reporting a real sha
rather than `unset` is the proof it worked.

### The one that is a trap in staging

**`SWAGGER_ENABLED`.** Because staging runs `NODE_ENV=production`, the default
resolves to `false` there too — so **staging has no API docs unless it is set to
`true` explicitly**. That default exists because a forgotten variable once
published the whole API surface on the live service, and it is worth keeping.
But if the front-end work depends on reading `/api/docs` against staging, the
variable has to be present and `true` in `staging`, and absent in `production`.

### Email, which is a prerequisite rather than a setting

Transactional email carries invitations, email verification and password
resets, and **all three are on the critical path**: inviting parents to the
portal requires the inviting account's own address to have been verified, and
that verification arrives by email. If sending is broken, a school cannot
verify, so it cannot invite parents, and the failure presents as a permissions
error nobody can explain.

A provider will not send from a domain it cannot verify. Before setting these,
add `edugear.ng` to Resend and publish the SPF and DKIM records it gives you.
Then:

| Variable | Value |
| --- | --- |
| `EMAIL_PROVIDER` | `resend` |
| `RESEND_API_KEY` | the key from Resend |
| `EMAIL_FROM` | `EduGear <no-reply@edugear.ng>` |

Production refuses to boot if `EMAIL_FROM` is still a placeholder — the two in
circulation are `example.com` from `.env.example` and `edugear.app`, which
differs from the real domain by its TLD alone.

### What production refuses to boot without

`validateEnv` fails the deploy and lists **everything** wrong at once, so read
the whole list rather than fixing one line and redeploying. Under
`NODE_ENV=production`:

- `REDIS_URL` missing — without it rate limiting and the permission cache are
  per-instance, so a second replica silently weakens both;
- `CORS_ORIGINS` set to `*`;
- `JWT_ACCESS_SECRET` still containing `replace-me`.

And regardless of environment, when `EMAIL_PROVIDER=resend`:

- `RESEND_API_KEY` missing;
- `EMAIL_FROM` still a placeholder;
- `FRONTEND_URL` still pointing at localhost — every invitation and reset link
  would be a link to somebody's own machine.

A failed boot here is the system working.

### The two that must exist before a school is onboarded

`TRUSTED_PROXY_SECRET` (at least 32 characters) and the `R2_*` group. **Neither
fails the boot** — rate limiting falls back to the socket address, and uploads
refuse rather than crash — so their absence shows up as behaviour, not as an
error, which is exactly why they are easy to forget.

---

## Step 3 — do it again for the other environment

Switch environments at the top of the page and repeat steps 1 and 2. Nothing
carries across: not the nine settings, not a single variable.

---

## Step 4 — prove it, rather than trusting the page

A dashboard showing the right values is not evidence that the right values are
in force. That is the failure this whole arrangement exists around: the config
was ignored on the first service, migrations silently never ran, and with the
healthcheck also unset every broken deploy still reported success.

For each environment:

1. **Trigger a deploy.** An empty commit on the branch that environment tracks
   is enough — `main` for production, `develop` for staging.
2. **Find the pre-deploy step in the deploy log** and confirm it runs
   `prisma migrate deploy`. "No pending migrations to apply" is a pass.
3. **Confirm the deploy waits on the healthcheck** before going active.
4. **Ask the running process**, rather than reading the page again:

   ```bash
   npm run verify:deploy -- https://<service URL> production https://www.edugear.ng
   npm run verify:deploy -- https://<service URL> staging <staging front end>
   ```

   It checks that the database and cache are up, that `/api/health/live` reports
   a real commit rather than `unset`, that `APP_ENV` names the environment you
   meant, that Swagger is closed in production, that an unauthenticated route
   still answers 401, and that CORS refuses an origin it should not know.

   The third argument is optional but worth passing: without it the script can
   only prove CORS refuses a *stranger*, not that it permits the real front end
   — and a wrong `CORS_ORIGINS` fails every screen in the browser while the API
   looks perfectly healthy to `curl`.

   Read-only, unauthenticated, and it touches neither the Railway API nor the
   CLI. See [scripts/verify-deployment.ts](../scripts/verify-deployment.ts).

---

## Step 5 — delete `railway.json`

Only once **both** environments have passed step 4. In its own commit, so it is
trivial to revert if something was missed.

---

## Afterwards

Changing any of these is now a dashboard action, not a commit. Keep
`.railway/railway.ts` in step when you change one, or the record stops being
worth having — `npm run typecheck:railway` only proves the field names are real,
not that they match what Railway is running.
