# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

EduGear is a multi-tenant school management SaaS backend (NestJS 11 + Prisma 6 + PostgreSQL).
[README.md](README.md) documents the domain, the full endpoint table, the auth flows and deployment;
this file covers what you need to change code safely.

## Commands

```bash
docker compose up -d          # Postgres on 55432 (also creates edugear_test) + Redis on 56379
npm run prisma:migrate        # migrate dev
npm run db:seed               # demo schools; password Demo9Access2026
npm run start:dev             # http://localhost:3000/api  · docs at /api/docs

npm test                      # unit tests
npm run test:e2e              # integration tests
npm run lint                  # eslint --fix is already in the script
npx tsc --noEmit              # typecheck (CI runs this separately from build)
```

### Two Jest configurations

| | Unit | Integration |
| --- | --- | --- |
| Config | `jest` key in [package.json](package.json) | [test/jest-e2e.json](test/jest-e2e.json) |
| Location | `*.spec.ts` co-located in `src/` | `test/*.e2e-spec.ts` |
| Notes | no database | `--runInBand`, needs `TEST_DATABASE_URL` |

Run a single test:

```bash
npx jest src/auth/password.service.spec.ts
npx jest --config ./test/jest-e2e.json --runInBand -t "cannot read another school"
```

Integration tests pin Redis to **logical database 1** ([test/utils/redis-url.ts](test/utils/redis-url.ts))
and flush it in global setup. Rate-limit counters outlive a run (60s and 1h TTLs), so without the flush
a second run inside the window fails — and flushing db 0 would wipe a developer's local cache.

`test/global-setup.ts` runs `prisma migrate deploy` against `TEST_DATABASE_URL` once per e2e run, and
[test/setup-env.ts](test/setup-env.ts) forces `DATABASE_URL` to the test database and raises throttle
limits — so most suites are unaffected by rate limiting, except
[test/rate-limit.e2e-spec.ts](test/rate-limit.e2e-spec.ts), which sets its own limits before loading
the app.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs lint with `--max-warnings=0`, typecheck,
both test suites, `npm run build`, a clean-database `migrate deploy`, and a Docker image build.

## Tenant isolation — the invariant everything else protects

`schoolId` is never taken from a header, body or query string. The access token carries a membership
id; [jwt.strategy.ts](src/auth/strategies/jwt.strategy.ts) loads that membership, re-checks user /
membership / school status and token version, derives `schoolId`, and calls `RequestContext.setAuth()`.

From there, [tenant-guard.extension.ts](src/database/tenant-guard.extension.ts) — a Prisma client
extension reading the tenant from `AsyncLocalStorage` — injects `schoolId` into `where`, forces it into
`data` on creates, rejects writes that would move a row to another tenant, and **throws
`TenantContextMissingError` when no tenant context exists**. Failure, not leakage, is the default.

Rules that follow:

- **Inject `@InjectPrisma() prisma: TenantAwarePrisma`**, never `PrismaService`.
  [prisma.module.ts](src/database/prisma.module.ts) exports only the `PRISMA` token; the raw client
  stays private by design.
- **Register new tenant-owned models** in
  [src/database/tenant-models.ts](src/database/tenant-models.ts). `tenant-guard.extension.spec.ts`
  walks the Prisma DMMF and fails the build if a model gains a `schoolId` column without an entry —
  don't work around that test, add the entry.
- **`RequestContext.runAsSystem()` is the only escape hatch**, and it is deliberately greppable. It is
  legitimate for login (user lookup by email), tenant provisioning, the permission catalogue, refresh
  tokens and audit writes. Anywhere else, justify it.
- **`$queryRaw` / `$executeRaw` bypass the guard entirely.** Scope raw SQL by hand.
- Deeply nested relation writes are not rewritten — prefer top-level operations.
- `RequestContext.run*` wraps the callback in `startInContext` because Prisma promises are lazy; if you
  add a context helper, keep that subscription or queries will execute outside the scope.

## Request pipeline

`RequestContextMiddleware` (opens the ALS store) → `ThrottlerGuard` → `JwtAuthGuard` →
`PermissionsGuard`. All three guards are global in [app.module.ts](src/app.module.ts); order matters.

Route metadata comes from [src/common/decorators/index.ts](src/common/decorators/index.ts):
`@Public()`, `@RequirePermissions(...)`, `@AllowNoTenant()`, `@CurrentUser()`, `@CurrentSchool()`.
`PermissionsGuard` is also the last line of tenant defence — it rejects any authenticated request that
reached a handler without a resolved tenant unless the route is `@AllowNoTenant()`.

## Authorization

Permission-based, never `if (role === 'X')`. Roles are bundles of permissions, and the six system roles
are **copied into each school** at provisioning so a school can retune its own roles.

- Catalogue: [src/common/constants/permissions.ts](src/common/constants/permissions.ts), mirrored into
  the database on every boot by
  [permission-catalog.service.ts](src/tenants/permission-catalog.service.ts) — add a permission here
  and a deploy cannot drift.
- [access-control.service.ts](src/auth/access-control.service.ts) caches the membership snapshot for
  30s via [membership-cache.service.ts](src/auth/membership-cache.service.ts). **After any change to a
  membership, role or user, `await` the matching `invalidateMembership` / `invalidateRole` /
  `invalidateUser`** — otherwise the change is invisible for up to 30 seconds. These are async because
  the cache is Redis-backed; forgetting the `await` races the next request.
- Redis writes also maintain reverse index sets (`acl:role:<id>`, `acl:user:<id>`) so role- and
  user-wide invalidation can find affected memberships — a `Map` can be scanned, Redis cannot. If you
  add a new way to cache a snapshot, maintain those indexes or invalidation will silently miss it.

## Conventions

- Throw `AppException` with an `ErrorCode` ([src/common/errors/](src/common/errors/)); a single global
  filter renders the standard body (`errorCode`, `requestId`, `path`, …). Stack traces, SQL and Prisma
  internals must never reach a client.
- Never return Prisma models directly — map to a DTO. Global `ValidationPipe` runs with `whitelist` +
  `forbidNonWhitelisted`, so every input needs a DTO.
- `AuditService.record()` never throws; a failed audit write must not roll back the business operation.
  Add new action names to [src/audit/audit-actions.ts](src/audit/audit-actions.ts).
- Config is read through `ConfigService` against the typed tree in [src/config/](src/config/), validated
  at boot. The one sanctioned exception is
  [src/common/constants/throttle.ts](src/common/constants/throttle.ts), which reads `process.env`
  directly because `@Throttle()` decorators evaluate before DI exists.
- **Redis is required in production** and optional everywhere else. `RedisService.client` is `null`
  when `REDIS_URL` is unset, and callers fall back to in-process state — correct for a single instance
  only, which is why [env.validation.ts](src/config/env.validation.ts) refuses to boot production
  without it. Never make that fallback reachable in production. Refresh tokens stay in Postgres.
- Redis failures must not break requests: cache reads fall through to the database, writes are logged.
  A failed *invalidation* is logged at error level because it leaves stale permissions until the TTL.
- Migrations: `prisma migrate deploy` as a release step, never on container boot; `prisma db push` is
  never used against production. `prisma.config.ts` disables Prisma's implicit `.env` loading and loads
  `.env.local` then `.env` explicitly.

## Status

Phases 0, 1 and 2 are complete. **Phase 3 (Results) is next** — its models are deliberately absent
from the schema, so it starts with a migration. Do not skip ahead to Portal or Administration.

Feature modules follow the shape of [src/academics/](src/academics/), [src/students/](src/students/)
and [src/finance/](src/finance/): pure domain rules in their own file with a `*.spec.ts`, a service
holding the Prisma work, a thin controller that declares `@RequirePermissions` and records the audit
entry, and an `*.e2e-spec.ts` covering the rules, the permission boundary and cross-tenant access.

Conventions established across Phases 1 and 2, worth following:

- **Child resources are addressed flatly** (`/academics/terms/:id`, `/academics/class-arms/:id`) so a
  parent id in the URL can never disagree with the row's real parent. The parent is set on create and
  omitted from the update DTO, so `forbidNonWhitelisted` rejects reparenting. The exception is a join
  row with no id of its own — `/students/:studentId/guardians/:guardianId` — where the pair in the
  path *is* the identity.
- **Refuse a delete wherever a cascade would silently destroy records**: a class with arms, an arm
  with students, a guardian with links, a fee category in use.
- **Student counts are filtered to `ACTIVE`** everywhere they appear, so a withdrawal frees a place.
- Date arithmetic shared across academic periods lives in
  [date-range.ts](src/academics/date-range.ts) — reuse it rather than re-deriving overlap and
  containment.
- Generated identifiers (admission numbers, receipt numbers) read the last value and write the next,
  so the unique index is the real guard — retry on `P2002` rather than trusting the read.
- `Prisma.TransactionClient` does not match the extended client. Use `TxClient` from
  [prisma.service.ts](src/database/prisma.service.ts) for `$transaction` callbacks.

### Money (Phase 2)

- **Always `Prisma.Decimal`, never `number`.** [fee-math.ts](src/finance/fee-math.ts) holds the
  arithmetic and the status derivation; amounts become numbers only in DTOs, where they are read.
- **Only VERIFIED payments move a balance.** A recorded payment is `PENDING` and changes nothing —
  that is the whole point of verification, and pending amounts still count toward the overpayment
  ceiling.
- **Recompute an invoice from its verified payments**, never by adding or subtracting a delta.
  Rebuilding from the source cannot drift and makes rejection reverse correctly.
- **An issued invoice is immutable.** Line items are copied onto it at assignment; structure amounts
  are frozen once invoices exist. Retire a category or archive a structure instead of editing it.
- Waived and cancelled invoices are never counted as debts.
