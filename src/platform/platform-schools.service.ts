import { Injectable, Logger } from '@nestjs/common';
import {
  MembershipStatus,
  Prisma,
  SchoolStatus,
  StudentStatus,
} from '@prisma/client';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { AccessControlService } from '../auth/access-control.service';
import { SYSTEM_ROLES } from '../common/constants/roles';
import { RequestContext } from '../common/context/request-context';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import {
  PlatformSchoolDto,
  PlatformStatsDto,
  QuerySchoolsDto,
  SuspendSchoolDto,
} from './dto/platform.dto';

/**
 * What A4 can see and do about its tenants.
 *
 * Every read here crosses tenants, so every one of them says `runAsSystem` out
 * loud — the tenant guard is off on this whole surface, which is exactly why it
 * stays small and why it returns **metadata only**: who a school is, what state
 * it is in, how much it uses. No student names, no fees, no results. An operator
 * who needs those asks the school.
 */
@Injectable()
export class PlatformSchoolsService {
  private readonly logger = new Logger(PlatformSchoolsService.name);

  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly audit: AuditService,
    private readonly accessControl: AccessControlService,
  ) {}

  async list(query: QuerySchoolsDto): Promise<PaginatedDto<PlatformSchoolDto>> {
    const where: Prisma.SchoolWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { shortName: { contains: query.search, mode: 'insensitive' } },
              { slug: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await RequestContext.runAsSystem(() =>
      Promise.all([
        this.prisma.school.findMany({
          where,
          orderBy: { [query.sortBy]: query.sortOrder },
          skip: query.skip,
          take: query.limit,
        }),
        this.prisma.school.count({ where }),
      ]),
    );

    const usage = await this.usageFor(rows.map((row) => row.id));
    return paginate(
      rows.map((row) => this.toDto(row, usage.get(row.id))),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(schoolId: string): Promise<PlatformSchoolDto> {
    const school = await RequestContext.runAsSystem(() =>
      this.prisma.school.findUnique({ where: { id: schoolId } }),
    );
    if (!school) throw AppException.notFound('School');

    const usage = await this.usageFor([schoolId]);
    return this.toDto(school, usage.get(schoolId));
  }

  /**
   * Takes a school offline. Enforcement already exists — the JWT strategy
   * refuses any token whose school is not ACTIVE — but the cached membership
   * snapshots have to be dropped or staff keep working for up to the TTL.
   */
  async suspend(
    schoolId: string,
    dto: SuspendSchoolDto,
  ): Promise<PlatformSchoolDto> {
    const school = await this.requireSchool(schoolId);

    if (school.status === SchoolStatus.SUSPENDED) {
      throw AppException.conflict('This school is already suspended');
    }
    if (school.status === SchoolStatus.CANCELLED) {
      throw AppException.conflict(
        'This school is cancelled. Reactivate it before suspending it.',
      );
    }

    await RequestContext.runAsSystem(() =>
      this.prisma.school.update({
        where: { id: schoolId },
        data: { status: SchoolStatus.SUSPENDED },
      }),
    );
    await this.dropCachedSessions(schoolId);

    await this.record(
      AUDIT_ACTIONS.PLATFORM_SCHOOL_SUSPENDED,
      schoolId,
      `Suspended ${school.name}: ${dto.reason}`,
      { reason: dto.reason, previousStatus: school.status },
    );

    return this.findOne(schoolId);
  }

  async reactivate(schoolId: string): Promise<PlatformSchoolDto> {
    const school = await this.requireSchool(schoolId);

    if (school.status === SchoolStatus.ACTIVE) {
      throw AppException.conflict('This school is already active');
    }

    await RequestContext.runAsSystem(() =>
      this.prisma.school.update({
        where: { id: schoolId },
        // Clearing deletedAt too: reactivating a cancelled school is the undo.
        data: { status: SchoolStatus.ACTIVE, deletedAt: null },
      }),
    );
    await this.dropCachedSessions(schoolId);

    await this.record(
      AUDIT_ACTIONS.PLATFORM_SCHOOL_REACTIVATED,
      schoolId,
      `Reactivated ${school.name}`,
      { previousStatus: school.status },
    );

    return this.findOne(schoolId);
  }

  /**
   * Cancellation is a soft delete and nothing more. Tenant data is never
   * destroyed here: a school that leaves and comes back expects its records, and
   * a mistaken click must not be unrecoverable.
   */
  async cancel(
    schoolId: string,
    dto: SuspendSchoolDto,
  ): Promise<PlatformSchoolDto> {
    const school = await this.requireSchool(schoolId);

    if (school.status === SchoolStatus.CANCELLED) {
      throw AppException.conflict('This school is already cancelled');
    }

    await RequestContext.runAsSystem(() =>
      this.prisma.school.update({
        where: { id: schoolId },
        data: { status: SchoolStatus.CANCELLED, deletedAt: new Date() },
      }),
    );
    await this.dropCachedSessions(schoolId);

    await this.record(
      AUDIT_ACTIONS.PLATFORM_SCHOOL_CANCELLED,
      schoolId,
      `Cancelled ${school.name}: ${dto.reason}`,
      { reason: dto.reason, previousStatus: school.status },
    );

    return this.findOne(schoolId);
  }

  async stats(): Promise<PlatformStatsDto> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);

    return RequestContext.runAsSystem(async () => {
      const [byStatus, totalStudents, totalStaff, storage, recent] =
        await Promise.all([
          this.prisma.school.groupBy({
            by: ['status'],
            _count: { _all: true },
          }),
          this.prisma.student.count({
            where: { status: StudentStatus.ACTIVE },
          }),
          this.prisma.membership.count({
            where: { status: MembershipStatus.ACTIVE },
          }),
          this.prisma.fileObject.aggregate({ _sum: { sizeBytes: true } }),
          this.prisma.school.count({
            where: { createdAt: { gte: thirtyDaysAgo } },
          }),
        ]);

      const count = (status: SchoolStatus) =>
        byStatus.find((row) => row.status === status)?._count._all ?? 0;

      return {
        totalSchools: byStatus.reduce((sum, row) => sum + row._count._all, 0),
        activeSchools: count(SchoolStatus.ACTIVE),
        suspendedSchools: count(SchoolStatus.SUSPENDED),
        pendingSchools: count(SchoolStatus.PENDING),
        cancelledSchools: count(SchoolStatus.CANCELLED),
        totalStudents,
        totalStaff,
        storageBytes: storage._sum.sizeBytes ?? 0,
        newSchoolsLast30Days: recent,
      };
    });
  }

  // ---------------------------------------------------------------------------

  private async requireSchool(schoolId: string) {
    const school = await RequestContext.runAsSystem(() =>
      this.prisma.school.findUnique({ where: { id: schoolId } }),
    );
    if (!school) throw AppException.notFound('School');
    return school;
  }

  /**
   * A status change has to reach staff who are already signed in. There is no
   * school-wide cache key, so each membership is dropped individually — fine
   * here, because suspension is rare and this never runs on a hot path.
   */
  private async dropCachedSessions(schoolId: string): Promise<void> {
    const memberships = await RequestContext.runAsSystem(() =>
      this.prisma.membership.findMany({
        where: { schoolId },
        select: { id: true },
      }),
    );

    await Promise.all(
      memberships.map((membership) =>
        this.accessControl.invalidateMembership(membership.id),
      ),
    );
  }

  private async record(
    action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
    schoolId: string,
    description: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const actor = RequestContext.getPlatform();
    // Written against the school so its own trail shows what happened to it,
    // with an A4 operator rather than a member of its staff as the actor.
    await this.audit.record({
      action,
      entityType: 'School',
      entityId: schoolId,
      description,
      metadata: { ...metadata, platformAdminEmail: actor?.email },
      schoolId,
      actorUserId: actor?.userId ?? null,
      membershipId: null,
    });
  }

  /** Counts for a page of schools in four queries rather than four per school. */
  private async usageFor(schoolIds: string[]): Promise<
    Map<
      string,
      {
        studentCount: number;
        staffCount: number;
        classArmCount: number;
        storageBytes: number;
        ownerEmail: string | null;
        lastActivityAt: Date | null;
      }
    >
  > {
    const result = new Map<
      string,
      {
        studentCount: number;
        staffCount: number;
        classArmCount: number;
        storageBytes: number;
        ownerEmail: string | null;
        lastActivityAt: Date | null;
      }
    >();
    if (schoolIds.length === 0) return result;

    const where = { schoolId: { in: schoolIds } };

    const [students, staff, arms, storage, owners] =
      await RequestContext.runAsSystem(() =>
        Promise.all([
          this.prisma.student.groupBy({
            by: ['schoolId'],
            where: { ...where, status: StudentStatus.ACTIVE },
            _count: { _all: true },
          }),
          this.prisma.membership.groupBy({
            by: ['schoolId'],
            where: { ...where, status: MembershipStatus.ACTIVE },
            _count: { _all: true },
            _max: { updatedAt: true },
          }),
          this.prisma.classArm.groupBy({
            by: ['schoolId'],
            where,
            _count: { _all: true },
          }),
          this.prisma.fileObject.groupBy({
            by: ['schoolId'],
            where,
            _sum: { sizeBytes: true },
          }),
          this.prisma.membership.findMany({
            where: { ...where, role: { slug: SYSTEM_ROLES.PROPRIETOR } },
            select: {
              schoolId: true,
              user: { select: { email: true, lastLoginAt: true } },
            },
          }),
        ]),
      );

    for (const schoolId of schoolIds) {
      const owner = owners.find((row) => row.schoolId === schoolId);
      result.set(schoolId, {
        studentCount:
          students.find((r) => r.schoolId === schoolId)?._count._all ?? 0,
        staffCount:
          staff.find((r) => r.schoolId === schoolId)?._count._all ?? 0,
        classArmCount:
          arms.find((r) => r.schoolId === schoolId)?._count._all ?? 0,
        storageBytes:
          storage.find((r) => r.schoolId === schoolId)?._sum.sizeBytes ?? 0,
        ownerEmail: owner?.user.email ?? null,
        lastActivityAt: owner?.user.lastLoginAt ?? null,
      });
    }

    return result;
  }

  private toDto(
    school: {
      id: string;
      slug: string;
      name: string;
      shortName: string | null;
      email: string;
      phone: string | null;
      state: string | null;
      status: SchoolStatus;
      deletedAt: Date | null;
      createdAt: Date;
    },
    usage?: {
      studentCount: number;
      staffCount: number;
      classArmCount: number;
      storageBytes: number;
      ownerEmail: string | null;
      lastActivityAt: Date | null;
    },
  ): PlatformSchoolDto {
    return {
      id: school.id,
      slug: school.slug,
      name: school.name,
      shortName: school.shortName,
      email: school.email,
      phone: school.phone,
      state: school.state,
      status: school.status,
      deletedAt: school.deletedAt,
      createdAt: school.createdAt,
      studentCount: usage?.studentCount ?? 0,
      staffCount: usage?.staffCount ?? 0,
      classArmCount: usage?.classArmCount ?? 0,
      storageBytes: usage?.storageBytes ?? 0,
      ownerEmail: usage?.ownerEmail ?? null,
      lastActivityAt: usage?.lastActivityAt ?? null,
    };
  }
}
