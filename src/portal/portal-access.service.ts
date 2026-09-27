import { Injectable } from '@nestjs/common';
import { MembershipStatus } from '@prisma/client';
import { AccessControlService } from '../auth/access-control.service';
import { SYSTEM_ROLES } from '../common/constants/roles';
import { AuthContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { EmailService } from '../notifications/email.service';
import { SchoolSettingsService } from '../tenants/school-settings.service';
import { UsersService } from '../users/users.service';
import { PortalAccessDto } from './dto/portal.dto';

/**
 * Giving a parent a login.
 *
 * A parent is invited exactly as staff are — same user record, same
 * single-use token, same /users/accept-invitation — with the school's PARENT
 * role, whose only permission is portal.access. What they may see is decided
 * per request from their guardian links, not from the role.
 */
@Injectable()
export class PortalAccessService {
  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly users: UsersService,
    private readonly email: EmailService,
    private readonly accessControl: AccessControlService,
    private readonly settings: SchoolSettingsService,
  ) {}

  async status(guardianId: string): Promise<PortalAccessDto> {
    const guardian = await this.getGuardian(guardianId);
    const membership = guardian.userId
      ? await this.prisma.membership.findFirst({
          where: { userId: guardian.userId },
          include: { role: { select: { slug: true, isSystem: true } } },
        })
      : null;

    // A teacher who is also a parent here holds a staff membership, not a Parent
    // one. Reporting its status as their portal status would read as nonsense —
    // "INVITED" for someone who has worked here for years — so say plainly that
    // they use their staff login instead.
    const usesStaffLogin = Boolean(
      membership && membership.role.slug !== SYSTEM_ROLES.PARENT,
    );

    return {
      guardianId,
      email: guardian.email ?? '',
      status: membership?.status ?? 'NONE',
      invitedAt: usesStaffLogin ? null : (membership?.invitedAt ?? null),
      acceptedAt: usesStaffLogin ? null : (membership?.acceptedAt ?? null),
      ...(usesStaffLogin ? { usesStaffLogin: true } : {}),
    };
  }

  /** Invites — or re-sends the invitation to — a parent. */
  async invite(
    guardianId: string,
    auth: AuthContext,
  ): Promise<PortalAccessDto> {
    const guardian = await this.getGuardian(guardianId);

    if (!guardian.email) {
      throw AppException.conflict(
        'This parent has no email address on file. Add one before inviting them to the portal.',
      );
    }
    await this.settings.assertPortalEnabled();
    if (guardian.students.length === 0) {
      throw AppException.conflict(
        'This parent is not linked to any student, so the portal would show nothing',
      );
    }

    const role = await this.prisma.role.findFirst({
      where: { slug: SYSTEM_ROLES.PARENT },
      select: { id: true },
    });
    if (!role) {
      throw AppException.conflict(
        'This school has no Parent role to invite into',
      );
    }

    // Checked before anything is created. A login already used by another
    // parent in this school cannot become this one too: it would merge two
    // families' portals. (User is a global model; the lookup is by email.)
    const existing = await this.prisma.user.findUnique({
      where: { email: guardian.email },
      select: { id: true },
    });
    if (existing) {
      const other = await this.prisma.guardian.findFirst({
        where: { userId: existing.id, id: { not: guardianId } },
        select: { firstName: true, lastName: true },
      });
      if (other) {
        throw AppException.conflict(
          `That email already signs in as ${other.firstName} ${other.lastName}, another parent at this school`,
        );
      }

      // A member of staff at this school who is also a parent here. They already
      // have a login, and a second membership is not possible — so link their
      // existing one to this guardian record and the portal opens for their own
      // children. No invitation, because there is nothing to accept.
      const staff = await this.prisma.membership.findFirst({
        where: { userId: existing.id, status: MembershipStatus.ACTIVE },
        select: { id: true, invitedAt: true, acceptedAt: true },
      });
      if (staff) {
        return this.linkStaffLogin(guardianId, existing.id, guardian, staff);
      }
    }

    const { user, membership, token } = await this.users.createInvitation(
      {
        email: guardian.email,
        firstName: guardian.firstName,
        lastName: guardian.lastName,
        roleId: role.id,
      },
      auth,
      { guardianId },
    );

    await this.prisma.guardian.update({
      where: { id: guardianId },
      data: { userId: user.id },
    });

    const school = await this.prisma.school.findFirst({
      select: { name: true },
    });
    await this.email.sendParentInvitation({
      to: guardian.email,
      firstName: guardian.firstName,
      schoolName: school?.name ?? 'Your school',
      children: guardian.students.map((link) => link.student.firstName),
      token,
    });

    return {
      guardianId,
      email: guardian.email,
      status: membership.status,
      invitedAt: membership.invitedAt,
      acceptedAt: membership.acceptedAt,
    };
  }

  /**
   * Points a guardian record at a login that already exists because the person
   * works here. Their role does not change and they gain no staff permission
   * they did not have — PortalGuard reads the guardian link, not the role.
   */
  private async linkStaffLogin(
    guardianId: string,
    userId: string,
    guardian: { email: string | null; firstName: string; lastName: string },
    membership: { id: string; invitedAt: Date | null; acceptedAt: Date | null },
  ): Promise<PortalAccessDto> {
    await this.prisma.guardian.update({
      where: { id: guardianId },
      data: { userId },
    });

    // PortalGuard reads the guardian row, not the cached snapshot, so nothing
    // needs invalidating — but the snapshot is dropped anyway, because relying
    // on that detail staying true is how stale-permission bugs start.
    await this.accessControl.invalidateMembership(membership.id);

    return {
      guardianId,
      email: guardian.email ?? '',
      status: MembershipStatus.ACTIVE,
      invitedAt: membership.invitedAt,
      acceptedAt: membership.acceptedAt,
      /** They sign in with their staff login; there is nothing to send. */
      usesStaffLogin: true,
    };
  }

  async revoke(guardianId: string): Promise<PortalAccessDto> {
    const guardian = await this.getGuardian(guardianId);
    if (!guardian.userId) {
      throw AppException.conflict('This parent has no portal access to revoke');
    }

    const membership = await this.prisma.membership.findFirst({
      where: { userId: guardian.userId },
      include: { role: { select: { slug: true } } },
    });
    // Revoking a parent must never touch a staff login that happens to share
    // the email; only a PARENT membership is ours to end.
    if (membership && membership.role.slug === SYSTEM_ROLES.PARENT) {
      await this.prisma.membership.update({
        where: { id: membership.id },
        data: { status: MembershipStatus.REVOKED },
      });
      await this.accessControl.invalidateMembership(membership.id);
    }

    await this.prisma.guardian.update({
      where: { id: guardianId },
      data: { userId: null },
    });

    return this.status(guardianId);
  }

  private async getGuardian(id: string) {
    const guardian = await this.prisma.guardian.findUnique({
      where: { id },
      include: {
        students: { include: { student: { select: { firstName: true } } } },
      },
    });
    if (!guardian) throw AppException.notFound('Guardian');
    return guardian;
  }
}
