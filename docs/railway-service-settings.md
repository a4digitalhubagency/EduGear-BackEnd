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
4. Confirm the app answers: `/api/health` reports `database` and `cache` up,
   and `/api/health/live` reports the commit you just deployed.

Only once both environments pass should `railway.json` be deleted, in its own
commit.

## Afterwards

Changing any of these is now a dashboard action, not a commit. Keep
`.railway/railway.ts` in step when you change one, or the record stops being
worth having — `npm run typecheck:railway` only proves the field names are
real, not that they match what Railway is running.
