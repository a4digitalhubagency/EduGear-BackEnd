# EduGear Backend

Multi-tenant school management SaaS for private secondary schools, by A4 Technologies.

**Status: Phases 0–4 complete; Phase 5 (Administration) in progress.** The backend foundation
(auth, multi-tenancy, RBAC, audit), Student Management (sessions, terms, classes, arms, students,
guardians, promotion, spreadsheet import), Finance (fee structures, invoicing, verified payments,
receipts, statements, debtors, reminders), Results (subjects, assessment, scores, computation,
approval, report cards), attendance and the Parent Portal are live. Administration has role
management and school settings; academic configuration and audit views already exist from earlier
phases.

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
Application modules (auth, tenants, users, academics, students, guardians, finance, audit, …)
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
| GET | `/schools/me/roles/:id` | `roles.read` |
| POST | `/schools/me/roles` | `roles.update` + no escalation |
| PATCH | `/schools/me/roles/:id` | `roles.update` |
| PUT | `/schools/me/roles/:id/permissions` | `roles.update` + no escalation |
| POST | `/schools/me/roles/:id/reassign-members` | `roles.update` |
| DELETE | `/schools/me/roles/:id` | `roles.update` |
| GET | `/schools/me/settings` | `school.read` |
| PATCH | `/schools/me/settings` | `school.update` |
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
| GET | `/students/import/template` | `students.create` |
| POST | `/students/import` | `students.create` |
| POST | `/students/import/csv` | `students.create` |
| POST | `/students/bulk` (deprecated) | `students.create` |
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
| POST | `/finance/fee-categories` | `finance.create` |
| GET | `/finance/fee-categories` | `finance.read` |
| GET | `/finance/fee-categories/:id` | `finance.read` |
| PATCH | `/finance/fee-categories/:id` | `finance.update` |
| DELETE | `/finance/fee-categories/:id` | `finance.update` |
| POST | `/finance/fee-structures` | `finance.create` |
| GET | `/finance/fee-structures` | `finance.read` |
| GET | `/finance/fee-structures/:id` | `finance.read` |
| PATCH | `/finance/fee-structures/:id` | `finance.update` |
| POST | `/finance/fee-structures/:id/publish` | `finance.update` |
| POST | `/finance/fee-structures/:id/archive` | `finance.update` |
| DELETE | `/finance/fee-structures/:id` | `finance.update` |
| POST | `/finance/invoices/assign` | `finance.create` |
| GET | `/finance/invoices` | `finance.read` |
| GET | `/finance/invoices/:id` | `finance.read` |
| POST | `/finance/invoices/:id/discount` | `finance.update` |
| POST | `/finance/invoices/:id/waive` | `finance.update` |
| POST | `/finance/invoices/:id/cancel` | `finance.update` |
| POST | `/finance/payments` | `finance.create` |
| GET | `/finance/payments` | `finance.read` |
| GET | `/finance/payments/:id` | `finance.read` |
| POST | `/finance/payments/:id/verify` | `finance.verify` |
| POST | `/finance/payments/:id/reject` | `finance.verify` |
| GET | `/finance/payments/:id/receipt` | `finance.read` |
| GET | `/finance/students/:studentId/statement` | `finance.read` |
| GET | `/finance/reports/summary` | `finance.read` |
| GET | `/finance/reports/debtors` | `finance.read` |
| POST | `/finance/reminders` | `finance.update` |
| GET | `/finance/reminders` | `finance.read` |
| POST | `/results/subjects` | `academics.create` |
| GET | `/results/subjects` | `academics.read` |
| GET / PATCH / DELETE | `/results/subjects/:id` | `academics.read` / `update` / `delete` |
| GET / POST | `/results/classes/:classId/subjects` | `academics.read` / `update` |
| PATCH / DELETE | `/results/classes/:classId/subjects/:subjectId` | `academics.update` |
| PUT / DELETE | `/results/class-arms/:classArmId/subjects/:subjectId/teacher` | `academics.update` |
| GET | `/results/teaching-assignments` | `results.read` |
| GET / PUT | `/results/assessment-scheme` | `results.read` / `results.publish` |
| GET / PUT | `/results/grading-scale` | `results.read` / `results.publish` |
| POST | `/results/setup-defaults` | `results.publish` |
| GET | `/results/scores` | `results.read` |
| PUT | `/results/scores` | `results.create` + assigned teacher |
| POST | `/results/sheets/compute` | `results.update` + form teacher |
| GET | `/results/sheets`, `/results/sheets/:id` | `results.read` |
| POST | `/results/sheets/:id/submit` | `results.update` + form teacher |
| POST | `/results/sheets/:id/approve`, `/publish`, `/return` | `results.publish` |
| PATCH | `/results/sheets/:id/students/:studentId/comment` | `results.update` |
| GET | `/results/sheets/:id/report-cards` | `results.read` |
| GET | `/results/report-cards/:studentId?termId=` | `results.read` |
| GET / PUT | `/attendance/register` | `attendance.read` / `create` + form teacher |
| GET | `/attendance/summary`, `/attendance/students/:studentId` | `attendance.read` |
| GET / POST / DELETE | `/guardians/:guardianId/portal-access` | `guardians.read` / `update` |
| GET | `/portal/me`, `/portal/children`, `/portal/children/:studentId` | `portal.access` + own child |
| GET | `/portal/children/:studentId/fees` · `/results` · `/results/:termId` · `/attendance` | `portal.access` + own child |
| GET | `/portal/children/:studentId/payments/:paymentId/receipt` | `portal.access` + own child |
| POST | `/portal/children/:studentId/payments` | `portal.access` + own child |
| GET | `/portal/notifications` | `portal.access` |
| POST | `/portal/notifications/:id/read`, `/portal/notifications/read-all` | `portal.access` |
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
| Finance | `FeeCategory`, `FeeStructure`, `FeeStructureItem`, `StudentFee`, `StudentFeeItem`, `Payment` |
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
  finance/         fee structures, invoices, payments, receipts, reports, reminders
  results/         subjects, assessment, scores, result sheets, report cards
  attendance/      daily registers and term summaries
  portal/          parent logins and the parent-facing API
  audit/           audit service + trail endpoint
  notifications/   email (Resend / console) and the in-app inbox
  health/          liveness, database and cache readiness
test/              integration suites + helpers
```

---

## What Phase 1 delivered

Academic sessions, terms, classes and class arms · student admission, profiles, search, filtering
and status · guardians and student–guardian links · promotion and graduation · bulk import.

- A term's dates must sit inside its session's, and terms within a session may not overlap.
- A term can only be made current while its own session is current.
- `Class.level` is unique per school because promotion walks it (level *n* → *n+1*).
- Deleting is refused wherever a cascade would silently strip records.
- Student counts are always filtered to `ACTIVE`, so withdrawing a student frees their place.
- Import reads a school's own spreadsheet: CSV from Excel (BOM, CRLF, quoted fields), loose headers
  ("Surname", "Adm No", "Sex", "Class", "Parent Phone"), day-first dates, and classes by name.
  Every row is checked and every problem reported before anything is written. `ATOMIC` (default)
  writes all or nothing; `PARTIAL` writes the good rows; `dryRun` previews, admission numbers
  included. Parents are matched by phone in any format, then email, and siblings share one record.

---

## What Phase 2 delivered

Fee categories and structures · invoicing · payments with verification and receipts · discounts and
waivers · outstanding balances, debtor lists and collection reports · guardian fee reminders.

Money is `Decimal(12,2)` everywhere, never a float. Amounts become numbers only at the DTO boundary,
where they are read rather than added.

The rules that make the numbers trustworthy:

- **A recorded payment moves nothing.** It lands `PENDING`; only verification issues a receipt number
  and reduces a balance. That is what makes an unverified receipt harmless.
- **Invoices are recomputed from their verified payments**, never by adding a delta — so rejecting an
  already-verified payment reverses the balance correctly and totals cannot drift.
- **Pending payments count toward the overpayment ceiling**, so two bursars each recording the full
  balance cannot both be accepted.
- **An issued invoice is frozen.** Line items are copied onto the bill at assignment, so renaming or
  retiring a category never restates what a parent was charged, and structure amounts are locked once
  invoices exist.
- **Only `PUBLISHED` structures can be assigned**, and re-running an assignment skips students who
  already hold that invoice, so adding a late arrival bills only them.
- **Discounts and waivers are recorded with a reason**, leaving both what was billed and what was
  forgiven visible in the ledger.
- Withdrawn students are never billed; waived and cancelled invoices are never counted as debts.
- **Reminders** send one email per parent covering all their children, chase only what is not
  already awaiting verification, and honour a cooldown (default 7 days) read from the reminder log.
  Delivery uses Resend's batch API with idempotency keys. Families with no email come back with
  phone numbers so the bursar can call.

---

## What Phase 3 delivered

Subjects and what each class offers · subject-teacher assignments · an assessment scheme and grading
scale (with the 3 × CA + exam and WAEC A1–F9 defaults) · score entry · computed results with subject
and class positions · a DRAFT → SUBMITTED → APPROVED → PUBLISHED flow · report cards.

- **Scores belong to the assigned subject teacher**, a class's sheet to its form teacher. Every
  teacher holds `results.create`/`update`, so the permission alone would let any teacher touch any
  class; holders of `results.publish` (the principal) may act anywhere.
- **The computation is a pure function** (`compute-results.ts`) with the rules pinned in tests:
  averages over subjects taken (electives count only for takers), competition ranking with ties
  ("1st, 2nd, 2nd, 4th"), grades reached by whole marks and never rounded up.
- **Submitting refuses any missing score** and freezes the scores. What the principal approves is
  the stored snapshot, and it is exactly what the report card prints — cards are never recomputed on
  read. A published sheet can be returned to draft with a reason.
- The scheme's marks freeze once scores exist (renames still allowed); grading changes never touch a
  published card. Terms, arms, students and subjects with results refuse deletion.

---

## What Phase 4 delivered

Parent logins · a parent-facing API for children, fees, receipts, results and attendance · proof of
payment from parents · an in-app notification inbox · the daily attendance register it all reads.

- **A parent is invited exactly as staff are** — same user, same single-use token, same
  `/users/accept-invitation` — into the school's PARENT role, whose only permission is
  `portal.access`. Staff hold every permission *except* that one, so staff tokens are refused by the
  portal and parent tokens by everything else.
- **Which children a parent sees is decided per request from their guardian links.** The tenant
  guard cannot do this — both families are in the same school — so every child route checks the link
  first, and another family's child is a 404, never a 403, so the portal never confirms a child
  exists. This rule is mutation-tested.
- **Proof of payment from a parent lands PENDING** and moves nothing until the bursar verifies it,
  which is the survey's unverified-receipt problem handled at the source. Cash is refused: it is paid
  at the office.
- **Results are invisible until PUBLISHED.** Draft, submitted and approved sheets are simply absent.
- **Notifications** are written for invoices, verified and rejected payments, fee reminders and
  published results — only to parents with an active login, resolved at send time. Like the audit log
  they are a side effect: a failure is logged, never allowed to undo the event.
- **Attendance** is taken by the form teacher (or academic staff), for a school day inside a term and
  never a future one. Late counts as present and excused as absent on the report card, which now
  prints it.
- Re-sending an invitation retires the earlier link — for staff too, who previously could not be
  re-invited while an invitation was pending.

Known limit: a membership has one role per school, so a teacher who is also a parent at the same
school cannot hold both logins. Parents at a *different* school than they work at are fine.

Next: **Phase 5 — Administration.**

---

## Administration (Phase 5, in progress)

**Roles.** Create, rename, re-permission and delete custom roles; copy an existing role; move a
role's members elsewhere so a role in use can be emptied then deleted. One rule governs all of it,
and role assignment and invitations too: **you cannot grant a permission you do not hold**, and
**nobody changes their own role**. Standard roles can be re-permissioned but not renamed or deleted;
`PROPRIETOR` always holds everything, because it is how a school recovers from any other change —
which is also why no school can lock itself out. A permission change drops every holder's cached
snapshot, so it takes effect on the next request.

`portal.access` is the single exception to the granting rule: no member of staff holds it, since it
marks the Parent role rather than granting a staff capability. It is ignored only for the standard
Parent role and refused on any other.

**Settings** (`/schools/me/settings`) — each one changes behaviour, and changing one never rewrites
what was already issued:

| Setting | Effect |
| --- | --- |
| `admissionNumberPrefix` | `BSC/2025/0001` instead of `2025/0001`. The year's sequence continues across a change. |
| `receiptPrefix` | Same, for receipts (default `RCP`). |
| `portalEnabled` | Closes the parent portal school-wide without revoking a single login. |
| `reminderCooldownDays` | Default cooldown for fee reminders; a request can still override it. |
| `invoiceDueDays` | Due date for invoices whose fee structure sets none. Never overrides a real one. |
| `reportShowPosition` | Some schools deliberately do not rank children; hides class and subject positions. |
| `reportShowClassStats` | Hides class highest, lowest and average beside each subject. |

A school with no settings row has the defaults — reading never writes one, so nothing needed
back-filling for schools registered before this existed.
