import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MembershipStatus,
  Prisma,
  UserStatus,
  VerificationTokenType,
} from '@prisma/client';
import { AppConfig } from '../config/configuration';
import { AuthContext, RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { paginate, PaginatedDto } from '../common/dto/pagination.dto';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { AccessControlService } from '../auth/access-control.service';
import { RolesService } from '../tenants/roles.service';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { EmailService } from '../notifications/email.service';
import {
  AcceptInvitationDto,
  InviteUserDto,
  QueryUsersDto,
  StaffMemberDto,
  UpdateMembershipDto,
} from './dto/user.dto';

type MembershipWithRelations = Prisma.MembershipGetPayload<{
  include: { user: true; role: true };
}>;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly accessControl: AccessControlService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly roles: RolesService,
  ) {}

  /** Staff of the current school. Tenant filtering comes from the Prisma guard. */
  async list(query: QueryUsersDto): Promise<PaginatedDto<StaffMemberDto>> {
    const where: Prisma.MembershipWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.roleId ? { roleId: query.roleId } : {}),
      ...(query.search
        ? {
            user: {
              OR: [
                { firstName: { contains: query.search, mode: 'insensitive' } },
                { lastName: { contains: query.search, mode: 'insensitive' } },
                { email: { contains: query.search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };

    const orderBy: Prisma.MembershipOrderByWithRelationInput =
      query.sortBy === 'createdAt'
        ? { createdAt: query.sortOrder }
        : { user: { [query.sortBy]: query.sortOrder } };

    const [rows, total] = await Promise.all([
      this.prisma.membership.findMany({
        where,
        orderBy,
        skip: query.skip,
        take: query.limit,
        include: { user: true, role: true },
      }),
      this.prisma.membership.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toDto(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(membershipId: string): Promise<StaffMemberDto> {
    const membership = await this.prisma.membership.findFirst({
      where: { id: membershipId },
      include: { user: true, role: true },
    });
    if (!membership) throw AppException.notFound('Staff member');
    return this.toDto(membership);
  }

  /**
   * Invites someone to the current school. If the email already has an EduGear
   * account (they teach at another school), it is reused — this is exactly the
   * multi-school case the membership model exists for.
   */
  async invite(dto: InviteUserDto, auth: AuthContext): Promise<StaffMemberDto> {
    const { user, membership, role, token } = await this.createInvitation(
      dto,
      auth,
    );

    const school = await this.prisma.school.findFirst({
      where: { id: auth.schoolId },
    });

    await this.email.sendStaffInvitation({
      to: user.email,
      firstName: user.firstName,
      schoolName: school?.name ?? 'your school',
      roleName: role.name,
      token,
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.USER_INVITED,
      entityType: 'Membership',
      entityId: membership.id,
      description: `${user.email} invited as ${role.name}`,
      metadata: { email: user.email, roleSlug: role.slug },
    });

    return this.toDto(membership);
  }

  /**
   * The part of an invitation every kind of invitee shares: a user (reused if
   * the email already has an EduGear account elsewhere), an INVITED membership
   * in this school, and a single-use token for /users/accept-invitation. Staff
   * and parent invitations differ only in the email and audit that follow.
   */
  async createInvitation(
    dto: Pick<
      InviteUserDto,
      'email' | 'firstName' | 'lastName' | 'phone' | 'roleId' | 'staffId'
    >,
    auth: AuthContext,
    extraMetadata: Record<string, string> = {},
  ) {
    const role = await this.prisma.role.findFirst({
      where: { id: dto.roleId },
    });
    if (!role)
      throw AppException.badRequest(
        'The selected role does not exist in this school',
      );
    // An invitation is a grant like any other: it cannot exceed the inviter.
    await this.roles.assertMayAssign(dto.roleId, auth);

    const existingUser = await RequestContext.runAsSystem(() =>
      this.prisma.user.findUnique({ where: { email: dto.email } }),
    );

    if (existingUser) {
      const existingMembership = await this.prisma.membership.findFirst({
        where: { userId: existingUser.id },
      });
      // INVITED is a resend — the first email went to spam, or expired — and
      // REVOKED a re-invitation. Only live access blocks a new invitation.
      if (existingMembership?.status === MembershipStatus.ACTIVE) {
        throw AppException.duplicate(
          'This person already has access to this school',
        );
      }
      if (existingMembership?.status === MembershipStatus.SUSPENDED) {
        throw AppException.conflict(
          "This person's access is suspended. Reactivate it rather than inviting them again.",
        );
      }
    }

    const user =
      existingUser ??
      (await RequestContext.runAsSystem(() =>
        this.prisma.user.create({
          data: {
            email: dto.email,
            firstName: dto.firstName,
            lastName: dto.lastName,
            phone: dto.phone,
            // Placeholder credential: the invitee sets a real password on accept.
            passwordHash: 'invited',
            status: UserStatus.PENDING_VERIFICATION,
          },
        }),
      ));

    const membership = await this.prisma.membership.upsert({
      where: { userId_schoolId: { userId: user.id, schoolId: auth.schoolId } },
      create: {
        userId: user.id,
        // Prisma's types require the tenant column on create. Supplying it is
        // safe: the guard rejects any value other than the active tenant.
        schoolId: auth.schoolId,
        roleId: dto.roleId,
        staffId: dto.staffId,
        status: MembershipStatus.INVITED,
        invitedById: auth.userId,
        invitedAt: new Date(),
      },
      update: {
        roleId: dto.roleId,
        staffId: dto.staffId,
        status: MembershipStatus.INVITED,
        invitedById: auth.userId,
        invitedAt: new Date(),
      },
      include: { user: true, role: true },
    });

    // Only the newest link works. Scoped to this membership: the same person
    // may hold a pending invitation from another school.
    await this.prisma.verificationToken.updateMany({
      where: {
        userId: user.id,
        type: VerificationTokenType.INVITATION,
        consumedAt: null,
        metadata: { path: ['membershipId'], equals: membership.id },
      },
      data: { consumedAt: new Date() },
    });

    const { invitationTtlHours } = this.config.get('auth', { infer: true });
    const { raw } = await this.tokens.createVerificationToken({
      userId: user.id,
      type: VerificationTokenType.INVITATION,
      ttlMs: this.tokens.ttlHours(invitationTtlHours),
      metadata: {
        membershipId: membership.id,
        schoolId: auth.schoolId,
        ...extraMetadata,
      },
    });

    // A re-invitation after revocation must not be served a cached snapshot.
    await this.accessControl.invalidateMembership(membership.id);

    return { user, membership, role, token: raw };
  }

  /**
   * Public endpoint: the invitee sets their password. Runs system-scoped because
   * there is no session yet — the membership comes from the signed token's metadata.
   */
  async acceptInvitation(dto: AcceptInvitationDto): Promise<void> {
    this.passwords.assertMeetsPolicy(dto.password);

    const record = await this.tokens.consumeVerificationToken(
      dto.token,
      VerificationTokenType.INVITATION,
    );

    const metadata = (record.metadata ?? {}) as { membershipId?: string };
    if (!metadata.membershipId) {
      throw AppException.badRequest(
        'This invitation is no longer valid',
        ErrorCode.TOKEN_INVALID,
      );
    }

    const passwordHash = await this.passwords.hash(dto.password);

    await RequestContext.runAsSystem(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: record.userId },
          data: {
            passwordHash,
            status: UserStatus.ACTIVE,
            emailVerifiedAt: new Date(),
            ...(dto.firstName ? { firstName: dto.firstName } : {}),
            ...(dto.lastName ? { lastName: dto.lastName } : {}),
            ...(dto.phone ? { phone: dto.phone } : {}),
          },
        });

        await tx.membership.update({
          where: { id: metadata.membershipId },
          data: { status: MembershipStatus.ACTIVE, acceptedAt: new Date() },
        });
      }),
    );

    await this.accessControl.invalidateMembership(metadata.membershipId);

    const membership = await RequestContext.runAsSystem(() =>
      this.prisma.membership.findUnique({
        where: { id: metadata.membershipId! },
      }),
    );

    await this.audit.record({
      action: AUDIT_ACTIONS.USER_INVITATION_ACCEPTED,
      entityType: 'Membership',
      entityId: metadata.membershipId,
      schoolId: membership?.schoolId ?? null,
      actorUserId: record.userId,
      membershipId: metadata.membershipId,
    });
  }

  async update(
    membershipId: string,
    dto: UpdateMembershipDto,
    auth: AuthContext,
  ): Promise<StaffMemberDto> {
    const current = await this.prisma.membership.findFirst({
      where: { id: membershipId },
      include: { user: true, role: true },
    });
    if (!current) throw AppException.notFound('Staff member');

    if (dto.roleId && dto.roleId !== current.roleId) {
      const role = await this.prisma.role.findFirst({
        where: { id: dto.roleId },
      });
      if (!role)
        throw AppException.badRequest(
          'The selected role does not exist in this school',
        );
      // Nobody edits their own access level, and nobody hands out a role
      // carrying permissions they do not hold themselves.
      this.roles.assertNotSelf(current.userId, auth);
      await this.roles.assertMayAssign(dto.roleId, auth);
      await this.assertNotLastProprietor(current, auth);
    }

    if (dto.status === MembershipStatus.SUSPENDED) {
      await this.assertNotLastProprietor(current, auth);
    }

    const updated = await this.prisma.membership.update({
      where: { id: membershipId },
      data: {
        ...(dto.roleId ? { roleId: dto.roleId } : {}),
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.staffId !== undefined ? { staffId: dto.staffId } : {}),
      },
      include: { user: true, role: true },
    });

    await this.accessControl.invalidateMembership(membershipId);

    if (dto.roleId && dto.roleId !== current.roleId) {
      await this.audit.record({
        action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
        entityType: 'Membership',
        entityId: membershipId,
        description: `${current.user.email}: ${current.role.slug} → ${updated.role.slug}`,
        metadata: { from: current.role.slug, to: updated.role.slug },
      });
    }

    if (dto.status && dto.status !== current.status) {
      await this.audit.record({
        action:
          dto.status === MembershipStatus.SUSPENDED
            ? AUDIT_ACTIONS.USER_SUSPENDED
            : AUDIT_ACTIONS.USER_REACTIVATED,
        entityType: 'Membership',
        entityId: membershipId,
        metadata: { email: current.user.email },
      });
    }

    return this.toDto(updated);
  }

  /** Revokes school access without deleting the person's global account. */
  async revokeAccess(membershipId: string, auth: AuthContext): Promise<void> {
    const membership = await this.prisma.membership.findFirst({
      where: { id: membershipId },
      include: { user: true, role: true },
    });
    if (!membership) throw AppException.notFound('Staff member');

    await this.assertNotLastProprietor(membership, auth);

    await this.prisma.membership.update({
      where: { id: membershipId },
      data: { status: MembershipStatus.REVOKED },
    });

    // Kill any live session bound to this membership.
    await RequestContext.runAsSystem(() =>
      this.prisma.refreshToken.updateMany({
        where: { membershipId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );

    await this.accessControl.invalidateMembership(membershipId);

    await this.audit.record({
      action: AUDIT_ACTIONS.USER_ACCESS_REVOKED,
      entityType: 'Membership',
      entityId: membershipId,
      metadata: {
        email: membership.user.email,
        roleSlug: membership.role.slug,
      },
    });
  }

  /** A school must always keep at least one active proprietor. */
  private async assertNotLastProprietor(
    membership: MembershipWithRelations,
    auth: AuthContext,
  ): Promise<void> {
    if (membership.role.slug !== 'PROPRIETOR') return;

    const activeProprietors = await this.prisma.membership.count({
      where: { status: MembershipStatus.ACTIVE, role: { slug: 'PROPRIETOR' } },
    });

    if (activeProprietors <= 1) {
      throw AppException.conflict(
        'A school must have at least one active proprietor. Assign another proprietor first.',
      );
    }

    if (membership.userId === auth.userId) {
      this.logger.warn(
        { membershipId: membership.id },
        'Proprietor is changing their own access level',
      );
    }
  }

  private toDto(membership: MembershipWithRelations): StaffMemberDto {
    return {
      membershipId: membership.id,
      userId: membership.userId,
      email: membership.user.email,
      firstName: membership.user.firstName,
      lastName: membership.user.lastName,
      phone: membership.user.phone,
      staffId: membership.staffId,
      roleId: membership.roleId,
      roleName: membership.role.name,
      roleSlug: membership.role.slug,
      status: membership.status,
      emailVerified: membership.user.emailVerifiedAt !== null,
      lastLoginAt: membership.user.lastLoginAt,
      createdAt: membership.createdAt,
    };
  }
}
