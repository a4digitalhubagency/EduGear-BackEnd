# EduGear Backend

Multi-tenant school management SaaS for private secondary schools, by A4 Technologies.

**Status: Phases 0 and 1 complete.** The backend foundation (auth, multi-tenancy, RBAC, audit) and
Student Management (academic sessions, terms, classes, arms, students, guardians, promotion, bulk
import) are live. Finance, Results, Parent Portal and Administration are not built yet — their
schema foundations exist where noted.

---

## Architecture at a glance

```
Client
  ↓
API (NestJS, REST, /api)
  ↓  RequestContextMiddleware → opens AsyncLocalStorage context
Rate limiting (ThrottlerGuard)                    ← Redis storage, shared budget
  ↓
Authentication (JwtAuthGuard → JwtStrategy)
  ↓  resolves membership → sets tenant on the request context
Authorization (PermissionsGuard, permission-based) ← Redis permission cache, 30s
  ↓
Application modules (auth, tenants, users, academics, audit, notifications, health)
  ↓
Prisma + tenant-guard extension  ← injects schoolId, fails closed
  ↓
PostgreSQL (Neon in production)
```

Modular monolith. Each domain owns its controller, service, DTOs and authorization rules, so a
module can be extracted into a service later without unpicking shared business logic.

**Redis** backs rate limiting and the permission cache, so both are shared across instances. It is
required in production — boot fails without `REDIS_URL` rather than silently falling back to
per-instance state. Locally and in tests it is optional: without it the app degrades to in-process
storage, which is correct for exactly one instance. Refresh tokens stay in Postgres.

---

## Multi-tenancy

Every school is a tenant (`School`). Every school-owned table carries `schoolId`.

Three things enforce isolation, and none of them rely on a developer remembering:

1. **The server decides the tenant.** The access token carries a membership id; the JWT strategy
   loads that membership and derives `schoolId` from it. A tenant id in a header, body or query
   string is never trusted.
2. **The Prisma client is tenant-guarded.** `src/database/tenant-guard.extension.ts` intercepts
   every operation on a tenant-owned model and injects `schoolId` into `where`, forces it into
   `data`, rejects attempts to write another tenant's id, and **throws** when no tenant context
   exists. Failure, not leakage, is the default.
3. **Only the guarded client is injectable.** `PrismaModule` exports the `PRISMA` token; the raw
   `PrismaService` never leaves the module. Unscoped access requires
   `RequestContext.runAsSystem()`, which is deliberately easy to `grep`.

`src/database/tenant-models.ts` is the registry of tenant-owned models. A unit test walks the Prisma
DMMF and **fails the build** if a model gains a `schoolId` column without being registered.

Known limits, stated rather than assumed:

- `$queryRaw` / `$executeRaw` bypass the guard. Raw SQL must scope by hand.
- Deeply nested relation writes are not rewritten; prefer top-level operations.
- The schema is RLS-ready. Postgres row-level security can be layered underneath later for defence
  in depth without a schema change.

---

## Authentication

- **Passwords**: argon2id (19 MiB, t=2, p=1). Plaintext is never stored, logged or audited.
- **Access tokens**: short-lived JWTs (15m) carrying ids only — `sub`, `mid` (membership),
  `ver` (token version). No email, no role, no permissions.
- **Refresh tokens**: opaque 48-byte random strings, stored only as SHA-256 hashes, rotated on every
  use. Replaying a rotated token revokes the entire token family (theft detection).
- **Revocation without waiting for expiry**: user status, membership status, school status and token
  version are re-checked on every request.
- **Lockout**: 5 failed attempts locks the account for 15 minutes.
- **No user enumeration**: unknown emails burn comparable time and return the same error as a wrong
  password; `forgot-password` always returns the same response.

Flow:

```
register-school ──► school + roles + proprietor + session   (verification email sent)
login ──────────► access + refresh (+ memberships, permissions)
refresh ────────► rotates the pair; replay kills the family
switch-school ──► tokens for another school the same user belongs to
logout / logout-all ──► revoke one session / every session (bumps tokenVersion)
```

---

## RBAC

Authorization is permission-based, never `if (role === 'X')`. Roles are bundles of permissions.

Six system roles are **copied into every school** at provisioning, so a school can retune its own
roles later without affecting other tenants: `PROPRIETOR`, `PRINCIPAL`, `ADMINISTRATOR`,
`ACCOUNTANT`, `TEACHER`, `PARENT`.

35 permissions across `students`, `guardians`, `academics`, `attendance`, `finance`, `results`,
`users`, `roles`, `school`, `reports`, `audit`, `portal`. The catalogue lives in
`src/common/constants/permissions.ts` and is mirrored into the database on every boot, so a deploy
that adds a permission cannot drift.

Controllers declare what an action needs:

```ts
@RequirePermissions(PERMISSIONS.USERS_CREATE)
```

Effective permissions are resolved server-side per request from the membership's role, cached in
Redis for 30s and invalidated immediately on role change, revocation or password change — an
invalidation on one instance is seen by all of them.

---

## API

Base path `/api`. Interactive docs at `/api/docs`, OpenAPI JSON at `/api/docs-json`.

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/auth/register-school` | public |
| POST | `/auth/login` | public |
| POST | `/auth/refresh` | public |
| POST | `/auth/logout` | public |
| POST | `/auth/logout-all` | authenticated |
| POST | `/auth/switch-school/:schoolId` | authenticated |
| GET | `/auth/me` | authenticated |
| POST | `/auth/change-password` | authenticated |
| POST | `/auth/forgot-password` | public |
| POST | `/auth/reset-password` | public |
| POST | `/auth/verify-email` | public |
| POST | `/auth/resend-verification` | public |
| GET | `/schools/me` | `school.read` |
| PATCH | `/schools/me` | `school.update` |
| GET | `/schools/me/roles` | `roles.read` |
| GET | `/schools/me/permissions` | `roles.read` |
| GET | `/users` | `users.read` |
| POST | `/users/invite` | `users.create` |
| POST | `/users/accept-invitation` | public |
| GET | `/users/:membershipId` | `users.read` |
| PATCH | `/users/:membershipId` | `users.update` |
| DELETE | `/users/:membershipId` | `users.delete` |
| POST | `/academics/sessions` | `academics.create` |
| GET | `/academics/sessions` | `academics.read` |
| GET | `/academics/sessions/current` | `academics.read` |
| GET | `/academics/sessions/:id` | `academics.read` |
| PATCH | `/academics/sessions/:id` | `academics.update` |
| POST | `/academics/sessions/:id/set-current` | `academics.update` |
| DELETE | `/academics/sessions/:id` | `academics.delete` |
| POST | `/academics/terms` | `academics.create` |
| GET | `/academics/terms` | `academics.read` |
| GET | `/academics/terms/current` | `academics.read` |
| GET | `/academics/terms/:id` | `academics.read` |
| PATCH | `/academics/terms/:id` | `academics.update` |
| POST | `/academics/terms/:id/set-current` | `academics.update` |
| DELETE | `/academics/terms/:id` | `academics.delete` |
| POST | `/academics/classes` | `academics.create` |
| GET | `/academics/classes` | `academics.read` |
| GET | `/academics/classes/:id` | `academics.read` |
| PATCH | `/academics/classes/:id` | `academics.update` |
| DELETE | `/academics/classes/:id` | `academics.delete` |
| POST | `/academics/class-arms` | `academics.create` |
| GET | `/academics/class-arms` | `academics.read` |
| GET | `/academics/class-arms/:id` | `academics.read` |
| PATCH | `/academics/class-arms/:id` | `academics.update` |
| DELETE | `/academics/class-arms/:id` | `academics.delete` |
| POST | `/students` | `students.create` |
| POST | `/students/bulk` | `students.create` |
| POST | `/students/promotions` | `students.update` |
| GET | `/students` | `students.read` |
| GET | `/students/:id` | `students.read` |
| PATCH | `/students/:id` | `students.update` |
| PATCH | `/students/:id/status` | `students.update` |
| DELETE | `/students/:id` | `students.delete` |
| POST | `/guardians` | `guardians.create` |
| GET | `/guardians` | `guardians.read` |
| GET | `/guardians/:id` | `guardians.read` |
| PATCH | `/guardians/:id` | `guardians.update` |
| DELETE | `/guardians/:id` | `guardians.delete` |
| POST | `/students/:studentId/guardians` | `guardians.update` |
| PATCH | `/students/:studentId/guardians/:guardianId` | `guardians.update` |
| DELETE | `/students/:studentId/guardians/:guardianId` | `guardians.update` |
| GET | `/audit-logs` | `audit.read` |
| GET | `/health` | public |

Conventions: DTO validation on every input (`whitelist` + `forbidNonWhitelisted`), pagination via
`?page&limit&search&sortOrder`, and Prisma models are never returned directly.

Every error has the same shape:

```json
{
  "statusCode": 403,
  "errorCode": "INSUFFICIENT_PERMISSIONS",
  "message": "Missing required permission: users.read",
  "details": [],
  "requestId": "04c873b3-e8bd-4eac-93a5-2ba11c9ab862",
  "timestamp": "2026-08-16T14:06:37.937Z",
  "path": "/api/users"
}
```

Stack traces, SQL and Prisma internals never reach a client; 5xx bodies are generic in production.

---

## Database

Phase 0 schema (17 models). Tenant-owned models carry `schoolId`; uniqueness is tenant-scoped where
the domain demands it (e.g. `@@unique([schoolId, studentId])` — an admission number is unique within
a school, not globally).

| Group | Models |
| --- | --- |
| Tenant | `School` |
| Identity & access | `User`, `Membership`, `Role`, `Permission`, `RolePermission` |
| Sessions & tokens | `RefreshToken`, `VerificationToken` |
| Academic structure | `AcademicSession`, `Term`, `Class`, `ClassArm` |
| Students | `Student`, `Guardian`, `StudentGuardian` |
| Audit | `AuditLog` |

`User` is a **global identity**: school access is granted through `Membership`, so one person can
work at several schools — the architecture the brief asked for, not a `user.schoolId` shortcut.

Student and guardian models remain schema-only; `AcademicSession` and `Term` now have modules behind them.

---

## Audit logging

`AuditService.record()` captures tenant, actor, membership, action, entity type/id, IP, user agent
and request id. Metadata is redacted for credential-shaped keys before it is written. A failed audit
write logs loudly but never rolls back the business operation.

Covered today: login success/failure, account lockout, school registration and updates, staff
invitation and acceptance, role change, suspension, access revocation, password change/reset, email
verification, token refresh and refresh-token reuse. Phase 1–3 action names are already reserved so
log queries stay stable.

---

## Running locally

```bash
# 1. Install
npm install

# 2. Start Postgres (creates the test database too) and Redis
docker compose up -d

# 3. Configure
cp .env.example .env
# then set a real secret:
#   JWT_ACCESS_SECRET=$(openssl rand -base64 48)

# 4. Migrate and seed
npm run prisma:migrate     # or: npx prisma migrate deploy
npm run db:seed

# 5. Run
npm run start:dev          # http://localhost:3000/api/docs
```

Demo accounts (seed): `proprietor@brightstar.test`, `principal@brightstar.test`,
`bursar@brightstar.test`, `teacher@brightstar.test`, plus a second school
(`proprietor@graceheight.test`). Password: `Demo9Access2026`.

### Tests

```bash
npm test          # unit tests
npm run test:e2e  # integration tests (needs Postgres + TEST_DATABASE_URL)
npm run lint
npx tsc --noEmit
```

`test/tenant-isolation.e2e-spec.ts` is the suite that matters most: it proves School A cannot read,
update or delete School B's data at both the HTTP and Prisma layers.

### Other commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | Run the compiled app |
| `npm run prisma:deploy` | Apply migrations (production) |
| `npm run prisma:studio` | Browse the database |
| `npm run db:reset` | Drop, re-migrate and re-seed (development only) |

---

## Deployment

Target stack: **Railway** (API + Redis) · **Neon** (Postgres) · **Cloudflare R2** (files, Phase 2+) ·
**Resend** (email) · **Vercel** (frontend) · **Paystack** (payments, Phase 2).

- `DATABASE_URL` is Neon's **pooled** connection; `DIRECT_URL` is the direct one used by migrations.
- Run `npx prisma migrate deploy` as a **release step**, not on container boot, so parallel instances
  cannot race. `prisma db push` is never used against production.
- The Dockerfile is multi-stage, runs as a non-root user, and exposes a healthcheck against
  `/api/health`.
- Set `trust proxy` is already handled; rate limiting keys off the forwarded client IP.

### Environment variables

Full list with defaults in [.env.example](.env.example). Required in every environment:

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Pooled Postgres connection |
| `DIRECT_URL` | Direct connection, used by migrations |
| `JWT_ACCESS_SECRET` | ≥32 chars; `openssl rand -base64 48` |
| `APP_URL`, `FRONTEND_URL` | Used to build email links |
| `CORS_ORIGINS` | Comma-separated; `*` is rejected in production |
| `EMAIL_PROVIDER` | `console` (dev) or `resend` |
| `RESEND_API_KEY` | Required when `EMAIL_PROVIDER=resend` |
| `REDIS_URL` | Required in production; optional locally (falls back to in-process) |

Boot fails fast with a readable message if configuration is invalid — no request ever discovers a
missing variable at runtime.

---

## Project structure

```
prisma/            schema.prisma, migrations, seed
src/
  main.ts          bootstrap: helmet, CORS, Swagger, shutdown hooks
  app.module.ts    global pipes, filters, guards, logging, throttling
  config/          env validation + typed config tree
  common/
    constants/     permissions, roles, throttle budgets
    context/       AsyncLocalStorage request + tenant context
    decorators/    @Public, @RequirePermissions, @CurrentUser, @AllowNoTenant
    dto/           pagination
    errors/        error codes, AppException
    filters/       single exception filter
    guards/        JwtAuthGuard, PermissionsGuard
    middleware/    request context
  cache/           Redis connection (null when unconfigured)
  database/        PrismaService, tenant guard extension, model registry
  auth/            login, tokens, password, access control, permission cache
  tenants/         school provisioning, settings, roles, permission catalogue
  users/           staff invitation, listing, role changes, revocation
  academics/       academic sessions, terms, classes and class arms
  students/        admission, profiles, search and status
  guardians/       guardian records and student links
  audit/           audit service + trail endpoint
  notifications/   email (Resend / console)
  health/          liveness, database and cache readiness
test/              integration suites + helpers
```

---

## What Phase 1 delivered

Academic sessions, terms, classes and class arms · student admission, profiles, search, filtering
and status · guardians and student–guardian links · promotion and graduation · bulk import.

Rules worth knowing before extending it:

- A term's dates must sit inside its session's, and terms within a session may not overlap.
- A term can only be made current while its own session is current, so the two markers never
  disagree — Finance and Results will read both.
- `Class.level` is unique per school because promotion walks it (level *n* → *n+1*).
- Deleting is refused wherever a cascade would silently strip records: a class with arms, an arm
  with students, a guardian with links.
- Student counts are always filtered to `ACTIVE`, so withdrawing a student frees their place.
- Bulk import is all-or-nothing; a partial import cannot be safely re-run once admission numbers
  exist.

Next: **Phase 2 — Finance.** Its models are deliberately not in the schema yet.
