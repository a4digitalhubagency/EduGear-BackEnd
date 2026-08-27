import { Gender, PrismaClient } from '@prisma/client';
import { AccessControlService } from '../src/auth/access-control.service';
import {
  RequestContext,
  TenantContextMissingError,
} from '../src/common/context/request-context';
import { extendWithTenantGuard } from '../src/database/prisma.service';
import {
  closeTestApp,
  createTestApp,
  registerSchool,
  RegisteredSchool,
  resetDatabase,
  TestContext,
} from './utils/test-app';

/**
 * THE critical test suite for a multi-tenant product.
 *
 * It proves isolation at both layers that matter:
 *   1. HTTP — a token for school A can never surface school B's data.
 *   2. Prisma — the tenant guard filters, blocks and fails closed.
 */
describe('Tenant isolation (School A cannot reach School B)', () => {
  let ctx: TestContext;
  let schoolA: RegisteredSchool;
  let schoolB: RegisteredSchool;
  let studentA: { id: string; studentId: string };
  let studentB: { id: string; studentId: string };

  const authFor = (school: RegisteredSchool) => ({
    Authorization: `Bearer ${school.accessToken}`,
  });

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);

    schoolA = await registerSchool(ctx, { schoolName: 'Alpha College' });
    schoolB = await registerSchool(ctx, { schoolName: 'Beta Academy' });

    // Arrange student rows directly, bypassing the guard, so the test data is
    // guaranteed to exist in both tenants.
    const created = await Promise.all(
      [schoolA, schoolB].map((school, index) =>
        ctx.db.student.create({
          data: {
            schoolId: school.schoolId,
            studentId: `ADM-00${index + 1}`,
            firstName: index === 0 ? 'Ada' : 'Bola',
            lastName: 'Test',
            gender: Gender.FEMALE,
            admissionDate: new Date('2025-09-15'),
          },
        }),
      ),
    );
    studentA = created[0];
    studentB = created[1];
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  // -------------------------------------------------------------------------
  // HTTP layer
  // -------------------------------------------------------------------------

  it('returns only the caller’s own school profile', async () => {
    const responseA = await ctx
      .http()
      .get('/api/schools/me')
      .set(authFor(schoolA))
      .expect(200);
    const responseB = await ctx
      .http()
      .get('/api/schools/me')
      .set(authFor(schoolB))
      .expect(200);

    expect(responseA.body.id).toBe(schoolA.schoolId);
    expect(responseB.body.id).toBe(schoolB.schoolId);
    expect(responseA.body.id).not.toBe(responseB.body.id);
  });

  it('never lists another school’s staff', async () => {
    const response = await ctx
      .http()
      .get('/api/users')
      .set(authFor(schoolA))
      .expect(200);

    const emails = response.body.data.map(
      (row: { email: string }) => row.email,
    );
    expect(emails).toContain(schoolA.email);
    expect(emails).not.toContain(schoolB.email);
    expect(response.body.meta.total).toBe(1);
  });

  it('404s when school A requests school B’s membership by id', async () => {
    await ctx
      .http()
      .get(`/api/users/${schoolB.membershipId}`)
      .set(authFor(schoolA))
      .expect(404);
  });

  it('refuses to modify another school’s staff member', async () => {
    await ctx
      .http()
      .patch(`/api/users/${schoolB.membershipId}`)
      .set(authFor(schoolA))
      .send({ status: 'SUSPENDED' })
      .expect(404);

    const untouched = await ctx.db.membership.findUnique({
      where: { id: schoolB.membershipId },
    });
    expect(untouched?.status).toBe('ACTIVE');
  });

  it('never returns another school’s audit entries', async () => {
    const response = await ctx
      .http()
      .get('/api/audit-logs')
      .set(authFor(schoolA))
      .expect(200);

    const rows: { entityId: string | null }[] = response.body.data;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.entityId === schoolA.schoolId)).toBe(true);
    expect(rows.some((row) => row.entityId === schoolB.schoolId)).toBe(false);
  });

  it('rejects a still-valid token once the membership is revoked', async () => {
    const extra = await registerSchool(ctx, { schoolName: 'Gamma School' });

    await ctx.db.membership.update({
      where: { id: extra.membershipId },
      data: { status: 'REVOKED' },
    });
    // Mirrors what UsersService.revokeAccess does after writing the change.
    await ctx.app
      .get(AccessControlService)
      .invalidateMembership(extra.membershipId);

    const response = await ctx
      .http()
      .get('/api/schools/me')
      .set({ Authorization: `Bearer ${extra.accessToken}` })
      .expect(403);

    expect(response.body.errorCode).toBe('MEMBERSHIP_INACTIVE');
  });

  // -------------------------------------------------------------------------
  // Prisma layer — the guard itself
  // -------------------------------------------------------------------------

  describe('Prisma tenant guard', () => {
    let raw: PrismaClient;
    let guarded: ReturnType<typeof extendWithTenantGuard>;

    const asSchoolA = <T>(fn: () => Promise<T>) =>
      RequestContext.runWithTenant(
        {
          userId: schoolA.userId,
          membershipId: schoolA.membershipId,
          schoolId: schoolA.schoolId,
          roleId: 'test-role',
          roleSlug: 'PROPRIETOR',
          email: schoolA.email,
        },
        fn,
      );

    beforeAll(() => {
      raw = new PrismaClient({
        datasources: { db: { url: process.env.DATABASE_URL } },
      });
      guarded = extendWithTenantGuard(raw);
    });

    afterAll(async () => {
      await raw.$disconnect();
    });

    it('findMany returns only the active tenant’s rows', async () => {
      const students = await asSchoolA(() => guarded.student.findMany());
      expect(students).toHaveLength(1);
      expect(students[0].id).toBe(studentA.id);
    });

    it('findUnique cannot fetch another tenant’s row by id', async () => {
      const found = await asSchoolA(() =>
        guarded.student.findUnique({ where: { id: studentB.id } }),
      );
      expect(found).toBeNull();
    });

    it('findFirst ignores a hand-written cross-tenant filter', async () => {
      const found = await asSchoolA(() =>
        guarded.student.findFirst({ where: { schoolId: schoolB.schoolId } }),
      );
      expect(found).toBeNull();
    });

    it('count is scoped to the active tenant', async () => {
      const count = await asSchoolA(() => guarded.student.count());
      expect(count).toBe(1);
    });

    it('update cannot touch another tenant’s row', async () => {
      await expect(
        asSchoolA(() =>
          guarded.student.update({
            where: { id: studentB.id },
            data: { firstName: 'Hacked' },
          }),
        ),
      ).rejects.toThrow();

      const untouched = await raw.student.findUnique({
        where: { id: studentB.id },
      });
      expect(untouched?.firstName).toBe('Bola');
    });

    it('deleteMany cannot remove another tenant’s rows', async () => {
      const result = await asSchoolA(() =>
        guarded.student.deleteMany({ where: { schoolId: schoolB.schoolId } }),
      );
      expect(result.count).toBe(0);

      const stillThere = await raw.student.findUnique({
        where: { id: studentB.id },
      });
      expect(stillThere).not.toBeNull();
    });

    it('create forces the active tenant, ignoring the caller’s schoolId', async () => {
      await expect(
        asSchoolA(() =>
          guarded.student.create({
            data: {
              schoolId: schoolB.schoolId,
              studentId: 'ADM-999',
              firstName: 'Injected',
              lastName: 'Row',
              gender: Gender.MALE,
              admissionDate: new Date('2025-09-15'),
            },
          }),
        ),
      ).rejects.toThrow(/Refusing to write/);

      const leaked = await raw.student.findFirst({
        where: { studentId: 'ADM-999' },
      });
      expect(leaked).toBeNull();
    });

    it('create without a schoolId writes into the active tenant', async () => {
      const created = await asSchoolA(() =>
        guarded.student.create({
          data: {
            studentId: 'ADM-100',
            firstName: 'Auto',
            lastName: 'Scoped',
            gender: Gender.MALE,
            admissionDate: new Date('2025-09-15'),
          } as never,
        }),
      );

      expect(created.schoolId).toBe(schoolA.schoolId);
      await raw.student.delete({ where: { id: created.id } });
    });

    it('update cannot move a row to another tenant', async () => {
      await expect(
        asSchoolA(() =>
          guarded.student.update({
            where: { id: studentA.id },
            data: { schoolId: schoolB.schoolId },
          }),
        ),
      ).rejects.toThrow(/Refusing to write/);
    });

    it('fails closed when no tenant context exists at all', async () => {
      await expect(guarded.student.findMany()).rejects.toThrow(
        TenantContextMissingError,
      );
    });

    it('allows unscoped access only inside an explicit system scope', async () => {
      const all = await RequestContext.runAsSystem(() =>
        guarded.student.findMany(),
      );
      expect(all.length).toBe(2);
    });

    it('leaves non-tenant models (User) alone', async () => {
      const users = await asSchoolA(() => guarded.user.findMany());
      // Users are global identities: both proprietors are visible at this layer,
      // which is why every user-facing endpoint queries through Membership.
      expect(users.length).toBeGreaterThanOrEqual(2);
    });
  });
});
