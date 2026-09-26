import { Injectable, Logger } from '@nestjs/common';
import { PlatformRole, UserStatus } from '@prisma/client';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { GrantPlatformAccessDto, PlatformAdminDto } from './dto/platform.dto';

/** What the JWT strategy needs to trust a platform token. */
export interface PlatformAdminSnapshot {
  id: string;
  userId: string;
  role: PlatformRole;
  disabledAt: Date | null;
  email: string;
  userStatus: UserStatus;
  tokenVersion: number;
}

/**
 * Who at A4 may operate the platform.
 *
 * Platform access is never granted to a user who belongs to a school, and a
 * school can never invite a platform admin's email. That separation is the whole
 * security argument for this surface: if the two overlapped, one phished school
 * proprietor would be every school's problem.
 */
@Injectable()
export class PlatformAdminService {
  private readonly logger = new Logger(PlatformAdminService.name);

  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly audit: AuditService,
  ) {}

  /**
   * Read on every platform request. Not cached: platform admins are a handful of
   * rows, and revoking one must bite immediately rather than after a TTL.
   */
  async snapshot(
    platformAdminId: string,
  ): Promise<PlatformAdminSnapshot | null> {
    const row = await RequestContext.runAsSystem(() =>
      this.prisma.platformAdmin.findUnique({
        where: { id: platformAdminId },
        include: {
          user: {
            select: { email: true, status: true, tokenVersion: true },
          },
        },
      }),
    );
    if (!row) return null;

    return {
      id: row.id,
      userId: row.userId,
      role: row.role,
      disabledAt: row.disabledAt,
      email: row.user.email,
      userStatus: row.user.status,
      tokenVersion: row.user.tokenVersion,
    };
  }

  /** Looked up at login, by email, before any password is checked. */
  async findByEmail(email: string): Promise<PlatformAdminSnapshot | null> {
    const row = await RequestContext.runAsSystem(() =>
      this.prisma.platformAdmin.findFirst({
        where: { user: { email: email.trim().toLowerCase() } },
        select: { id: true },
      }),
    );
    return row ? this.snapshot(row.id) : null;
  }

  async list(): Promise<PlatformAdminDto[]> {
    const rows = await RequestContext.runAsSystem(() =>
      this.prisma.platformAdmin.findMany({
        include: {
          user: {
            select: {
              email: true,
              firstName: true,
              lastName: true,
              status: true,
              lastLoginAt: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );

    return rows.map((row) => ({
      id: row.id,
      email: row.user.email,
      fullName: `${row.user.firstName} ${row.user.lastName}`,
      role: row.role,
      userStatus: row.user.status,
      lastLoginAt: row.user.lastLoginAt,
      disabledAt: row.disabledAt,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Grants platform access to an existing user. The user must already exist and
   * must belong to no school — this does not create accounts, because an
   * operator account should be made deliberately, not as a side effect.
   */
  async grant(dto: GrantPlatformAccessDto): Promise<PlatformAdminDto> {
    const email = dto.email.trim().toLowerCase();

    const user = await RequestContext.runAsSystem(() =>
      this.prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          status: true,
          lastLoginAt: true,
          _count: { select: { memberships: true } },
          platformAdmin: { select: { id: true } },
        },
      }),
    );

    if (!user) {
      throw AppException.notFound('User');
    }
    if (user.platformAdmin) {
      throw AppException.conflict('This user already has platform access');
    }
    if (user._count.memberships > 0) {
      throw AppException.conflict(
        'This user belongs to a school. Platform access must use a separate ' +
          'account, so that a compromised school login cannot reach the platform.',
      );
    }

    const granter = RequestContext.getPlatform();
    const created = await RequestContext.runAsSystem(() =>
      this.prisma.platformAdmin.create({
        data: {
          userId: user.id,
          role: dto.role,
          grantedById: granter?.platformAdminId ?? null,
        },
      }),
    );

    await this.audit.record({
      action: AUDIT_ACTIONS.PLATFORM_ACCESS_GRANTED,
      entityType: 'PlatformAdmin',
      entityId: created.id,
      description: `Granted ${dto.role} platform access to ${user.email}`,
      metadata: { email: user.email, role: dto.role },
      schoolId: null,
      actorUserId: granter?.userId ?? null,
      membershipId: null,
    });

    return {
      id: created.id,
      email: user.email,
      fullName: `${user.firstName} ${user.lastName}`,
      role: created.role,
      userStatus: user.status,
      lastLoginAt: user.lastLoginAt,
      disabledAt: null,
      createdAt: created.createdAt,
    };
  }

  /**
   * Revokes access without deleting the row, so what they did stays attributable.
   * Their sessions die on the next request because the strategy reads this row
   * every time.
   */
  async revoke(platformAdminId: string): Promise<void> {
    const actor = RequestContext.getPlatform();
    // This one rule is also what stops A4 locking itself out. Only an owner can
    // revoke, so for the target to be the last active owner the caller would
    // have to be a second one — a contradiction. Anyone adding another way to
    // demote or disable an owner must re-establish that invariant, because it
    // does not hold on its own.
    if (actor?.platformAdminId === platformAdminId) {
      throw AppException.conflict('You cannot revoke your own platform access');
    }

    const existing = await this.snapshot(platformAdminId);
    if (!existing) throw AppException.notFound('Platform admin');

    await RequestContext.runAsSystem(() =>
      this.prisma.platformAdmin.update({
        where: { id: platformAdminId },
        data: { disabledAt: new Date() },
      }),
    );

    await this.audit.record({
      action: AUDIT_ACTIONS.PLATFORM_ACCESS_REVOKED,
      entityType: 'PlatformAdmin',
      entityId: platformAdminId,
      description: `Revoked platform access from ${existing.email}`,
      metadata: { email: existing.email, role: existing.role },
      schoolId: null,
      actorUserId: actor?.userId ?? null,
      membershipId: null,
    });
  }

  /** True when this email must not be invited into a school. */
  async isPlatformEmail(email: string): Promise<boolean> {
    const found = await RequestContext.runAsSystem(() =>
      this.prisma.platformAdmin.findFirst({
        where: { user: { email: email.trim().toLowerCase() } },
        select: { id: true },
      }),
    );
    if (found) {
      this.logger.warn(
        `Refused to attach a school membership to platform account ${email}`,
      );
    }
    return Boolean(found);
  }

  /** Guards the school-side invitation paths. */
  async assertNotPlatformEmail(email: string): Promise<void> {
    if (await this.isPlatformEmail(email)) {
      throw AppException.conflict(
        'That email belongs to an EduGear platform account and cannot be added ' +
          'to a school.',
        ErrorCode.CONFLICT,
      );
    }
  }
}
