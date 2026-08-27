import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MembershipStatus,
  SchoolStatus,
  User,
  UserStatus,
  VerificationTokenType,
} from '@prisma/client';
import { AppConfig } from '../config/configuration';
import { SYSTEM_ROLES } from '../common/constants/roles';
import { AuthContext, RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { EmailService } from '../notifications/email.service';
import { SchoolsService } from '../tenants/schools.service';
import { AccessControlService } from './access-control.service';
import { PasswordService } from './password.service';
import { SessionMeta, TokenService } from './token.service';
import {
  AuthUserDto,
  ChangePasswordDto,
  LoginDto,
  MembershipSummaryDto,
  ProfileDto,
  RegisterSchoolDto,
  SessionDto,
} from './dto/auth.dto';

/**
 * A pre-computed argon2 hash of a random string. Verifying against it on an
 * unknown email keeps login timing roughly constant, so the endpoint cannot be
 * used to discover which addresses have accounts.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$RYRWC+3VnS6c5UNmqnw2cA$tiOATtTmmhp/aVeRrZfpu5moIUERPYtzUdd9k8bBhg8';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly accessControl: AccessControlService,
    private readonly schools: SchoolsService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Self-service school signup: creates the tenant, its role set, and the
   * proprietor account in one transaction. Either all of it exists or none of it.
   */
  async registerSchool(
    dto: RegisterSchoolDto,
    meta: SessionMeta,
  ): Promise<SessionDto> {
    this.passwords.assertMeetsPolicy(dto.password);

    const existing = await RequestContext.runAsSystem(() =>
      this.prisma.user.findUnique({ where: { email: dto.email } }),
    );
    if (existing) {
      throw AppException.duplicate('An account with this email already exists');
    }

    const passwordHash = await this.passwords.hash(dto.password);

    // No tenant exists yet, so provisioning is explicitly system-scoped.
    const { user, membership } = await RequestContext.runAsSystem(() =>
      this.prisma.$transaction(async (tx) => {
        const { school, roleIdsBySlug } = await this.schools.provisionSchool(
          tx,
          {
            name: dto.schoolName,
            email: dto.schoolEmail,
            phone: dto.schoolPhone,
            city: dto.city,
            state: dto.state,
          },
        );

        const createdUser = await tx.user.create({
          data: {
            email: dto.email,
            passwordHash,
            firstName: dto.firstName,
            lastName: dto.lastName,
            phone: dto.phone,
            // The proprietor can work immediately; the verification email still
            // goes out and gates sensitive actions added later.
            status: UserStatus.ACTIVE,
          },
        });

        const createdMembership = await tx.membership.create({
          data: {
            userId: createdUser.id,
            schoolId: school.id,
            roleId: roleIdsBySlug[SYSTEM_ROLES.PROPRIETOR],
            status: MembershipStatus.ACTIVE,
            isDefault: true,
            acceptedAt: new Date(),
          },
        });

        return { user: createdUser, membership: createdMembership, school };
      }),
    );

    await this.audit.record({
      action: AUDIT_ACTIONS.SCHOOL_REGISTERED,
      entityType: 'School',
      entityId: membership.schoolId,
      schoolId: membership.schoolId,
      actorUserId: user.id,
      membershipId: membership.id,
      description: `${dto.schoolName} registered by ${dto.email}`,
    });

    await this.sendVerificationEmail(user);

    const tokens = await this.tokens.issueTokens({
      userId: user.id,
      membershipId: membership.id,
      tokenVersion: user.tokenVersion,
      meta,
    });

    return this.buildSession(user, membership.id, tokens);
  }

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  async login(dto: LoginDto, meta: SessionMeta): Promise<SessionDto> {
    const authPolicy = this.config.get('auth', { infer: true });

    const user = await RequestContext.runAsSystem(() =>
      this.prisma.user.findUnique({ where: { email: dto.email } }),
    );

    if (!user) {
      // Burn comparable time, then fail with the same message as a bad password.
      await this.passwords.verify(DUMMY_HASH, dto.password);
      await this.audit.record({
        action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
        schoolId: null,
        actorUserId: null,
        membershipId: null,
        description: 'Login attempt for unknown email',
        metadata: { email: dto.email },
      });
      throw AppException.unauthorized(
        'Invalid email or password',
        ErrorCode.INVALID_CREDENTIALS,
      );
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw AppException.unauthorized(
        'Account temporarily locked after too many failed attempts. Try again later.',
        ErrorCode.ACCOUNT_LOCKED,
      );
    }

    const valid = await this.passwords.verify(user.passwordHash, dto.password);
    if (!valid) {
      await this.registerFailedAttempt(
        user,
        authPolicy.maxFailedLoginAttempts,
        authPolicy.accountLockMinutes,
      );
      throw AppException.unauthorized(
        'Invalid email or password',
        ErrorCode.INVALID_CREDENTIALS,
      );
    }

    if (user.status === UserStatus.PENDING_VERIFICATION) {
      throw AppException.forbidden(
        'Your invitation is still pending. Use the link in your invitation email to finish setting up your account.',
        ErrorCode.ACCOUNT_INACTIVE,
      );
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw AppException.forbidden(
        'This account is not active',
        ErrorCode.ACCOUNT_INACTIVE,
      );
    }

    const membership = await this.resolveMembership(user.id, dto.schoolId);

    await RequestContext.runAsSystem(() =>
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
        },
      }),
    );

    const tokens = await this.tokens.issueTokens({
      userId: user.id,
      membershipId: membership.id,
      tokenVersion: user.tokenVersion,
      meta,
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED,
      entityType: 'User',
      entityId: user.id,
      schoolId: membership.schoolId,
      actorUserId: user.id,
      membershipId: membership.id,
    });

    return this.buildSession(user, membership.id, tokens);
  }

  /**
   * Picks the membership to sign into. A client-supplied `schoolId` is only ever
   * used to select among memberships this user actually holds.
   */
  private async resolveMembership(userId: string, requestedSchoolId?: string) {
    const memberships = await RequestContext.runAsSystem(() =>
      this.prisma.membership.findMany({
        where: {
          userId,
          status: MembershipStatus.ACTIVE,
          school: { status: SchoolStatus.ACTIVE },
        },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      }),
    );

    if (memberships.length === 0) {
      throw AppException.forbidden(
        'This account has no active school access',
        ErrorCode.MEMBERSHIP_INACTIVE,
      );
    }

    if (requestedSchoolId) {
      const requested = memberships.find(
        (m) => m.schoolId === requestedSchoolId,
      );
      if (!requested) {
        throw AppException.forbidden(
          'You do not have active access to that school',
          ErrorCode.TENANT_ACCESS_DENIED,
        );
      }
      return requested;
    }

    return memberships[0];
  }

  private async registerFailedAttempt(
    user: User,
    maxAttempts: number,
    lockMinutes: number,
  ): Promise<void> {
    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= maxAttempts;

    await RequestContext.runAsSystem(() =>
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: shouldLock ? 0 : attempts,
          lockedUntil: shouldLock
            ? new Date(Date.now() + lockMinutes * 60_000)
            : user.lockedUntil,
        },
      }),
    );

    await this.audit.record({
      action: shouldLock
        ? AUDIT_ACTIONS.AUTH_ACCOUNT_LOCKED
        : AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
      entityType: 'User',
      entityId: user.id,
      schoolId: null,
      actorUserId: user.id,
      membershipId: null,
      metadata: { attempts },
    });
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async refresh(refreshToken: string, meta: SessionMeta) {
    const { tokens, userId, membershipId } =
      await this.tokens.rotateRefreshToken(refreshToken, meta);

    await this.audit.record({
      action: AUDIT_ACTIONS.AUTH_TOKEN_REFRESHED,
      entityType: 'User',
      entityId: userId,
      actorUserId: userId,
      membershipId,
      schoolId: undefined,
    });

    return tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revokeRefreshToken(refreshToken);
    await this.audit.record({ action: AUDIT_ACTIONS.AUTH_LOGOUT });
  }

  async logoutAll(userId: string): Promise<void> {
    await this.tokens.revokeAllForUser(userId);
    // Bumping the version kills every outstanding *access* token too.
    await RequestContext.runAsSystem(() =>
      this.prisma.user.update({
        where: { id: userId },
        data: { tokenVersion: { increment: 1 } },
      }),
    );
    await this.accessControl.invalidateUser(userId);
    await this.audit.record({ action: AUDIT_ACTIONS.AUTH_LOGOUT_ALL });
  }

  /** Moves an authenticated session to another school the same user belongs to. */
  async switchSchool(
    auth: AuthContext,
    schoolId: string,
    meta: SessionMeta,
  ): Promise<SessionDto> {
    const membership = await RequestContext.runAsSystem(() =>
      this.prisma.membership.findUnique({
        where: { userId_schoolId: { userId: auth.userId, schoolId } },
        include: { school: true, user: true },
      }),
    );

    if (
      !membership ||
      membership.status !== MembershipStatus.ACTIVE ||
      membership.school.status !== SchoolStatus.ACTIVE
    ) {
      throw AppException.forbidden(
        'You do not have active access to that school',
        ErrorCode.TENANT_ACCESS_DENIED,
      );
    }

    const tokens = await this.tokens.issueTokens({
      userId: auth.userId,
      membershipId: membership.id,
      tokenVersion: membership.user.tokenVersion,
      meta,
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.AUTH_SCHOOL_SWITCHED,
      entityType: 'Membership',
      entityId: membership.id,
      schoolId: membership.schoolId,
      actorUserId: auth.userId,
      membershipId: membership.id,
    });

    return this.buildSession(membership.user, membership.id, tokens);
  }

  // -------------------------------------------------------------------------
  // Passwords and verification
  // -------------------------------------------------------------------------

  async forgotPassword(email: string): Promise<void> {
    const user = await RequestContext.runAsSystem(() =>
      this.prisma.user.findUnique({ where: { email } }),
    );

    // Always answer the same way — the caller cannot learn whether the account exists.
    if (!user || user.status === UserStatus.DEACTIVATED) {
      this.logger.debug(
        { email },
        'Password reset requested for unknown or inactive account',
      );
      return;
    }

    const { passwordResetTtlMinutes } = this.config.get('auth', {
      infer: true,
    });
    const { raw } = await this.tokens.createVerificationToken({
      userId: user.id,
      type: VerificationTokenType.PASSWORD_RESET,
      ttlMs: this.tokens.ttlMinutes(passwordResetTtlMinutes),
    });

    await this.email.sendPasswordReset(user.email, user.firstName, raw);
    await this.audit.record({
      action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET_REQUESTED,
      entityType: 'User',
      entityId: user.id,
      schoolId: null,
      actorUserId: user.id,
      membershipId: null,
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    this.passwords.assertMeetsPolicy(newPassword);

    const record = await this.tokens.consumeVerificationToken(
      token,
      VerificationTokenType.PASSWORD_RESET,
    );
    const passwordHash = await this.passwords.hash(newPassword);

    await RequestContext.runAsSystem(() =>
      this.prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          failedLoginAttempts: 0,
          lockedUntil: null,
          // Invalidate every existing session on a password reset.
          tokenVersion: { increment: 1 },
        },
      }),
    );

    await this.tokens.revokeAllForUser(record.userId);
    await this.accessControl.invalidateUser(record.userId);

    await this.audit.record({
      action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET_COMPLETED,
      entityType: 'User',
      entityId: record.userId,
      schoolId: null,
      actorUserId: record.userId,
      membershipId: null,
    });
  }

  async changePassword(
    auth: AuthContext,
    dto: ChangePasswordDto,
  ): Promise<void> {
    this.passwords.assertMeetsPolicy(dto.newPassword);

    const user = await RequestContext.runAsSystem(() =>
      this.prisma.user.findUnique({ where: { id: auth.userId } }),
    );
    if (!user) throw AppException.notFound('User');

    const valid = await this.passwords.verify(
      user.passwordHash,
      dto.currentPassword,
    );
    if (!valid) {
      throw AppException.unauthorized(
        'Current password is incorrect',
        ErrorCode.INVALID_CREDENTIALS,
      );
    }

    const passwordHash = await this.passwords.hash(dto.newPassword);
    await RequestContext.runAsSystem(() =>
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, tokenVersion: { increment: 1 } },
      }),
    );

    await this.tokens.revokeAllForUser(user.id);
    await this.accessControl.invalidateUser(user.id);

    await this.audit.record({
      action: AUDIT_ACTIONS.AUTH_PASSWORD_CHANGED,
      entityType: 'User',
      entityId: user.id,
    });
  }

  async verifyEmail(token: string): Promise<void> {
    const record = await this.tokens.consumeVerificationToken(
      token,
      VerificationTokenType.EMAIL_VERIFICATION,
    );

    await RequestContext.runAsSystem(() =>
      this.prisma.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date() },
      }),
    );
    await this.accessControl.invalidateUser(record.userId);

    await this.audit.record({
      action: AUDIT_ACTIONS.AUTH_EMAIL_VERIFIED,
      entityType: 'User',
      entityId: record.userId,
      schoolId: null,
      actorUserId: record.userId,
      membershipId: null,
    });
  }

  async resendVerification(email: string): Promise<void> {
    const user = await RequestContext.runAsSystem(() =>
      this.prisma.user.findUnique({ where: { email } }),
    );
    if (!user || user.emailVerifiedAt) return;
    await this.sendVerificationEmail(user);
  }

  private async sendVerificationEmail(user: User): Promise<void> {
    const { emailVerificationTtlHours } = this.config.get('auth', {
      infer: true,
    });
    const { raw } = await this.tokens.createVerificationToken({
      userId: user.id,
      type: VerificationTokenType.EMAIL_VERIFICATION,
      ttlMs: this.tokens.ttlHours(emailVerificationTtlHours),
    });
    await this.email.sendEmailVerification(user.email, user.firstName, raw);
  }

  // -------------------------------------------------------------------------
  // Profile
  // -------------------------------------------------------------------------

  async getProfile(auth: AuthContext): Promise<ProfileDto> {
    const snapshot = await this.accessControl.getMembershipSnapshot(
      auth.membershipId,
    );
    if (!snapshot) throw AppException.notFound('Membership');

    const user = await RequestContext.runAsSystem(() =>
      this.prisma.user.findUnique({ where: { id: auth.userId } }),
    );
    if (!user) throw AppException.notFound('User');

    return {
      user: this.toUserDto(user),
      activeSchool: {
        membershipId: snapshot.membershipId,
        schoolId: snapshot.schoolId,
        schoolName: snapshot.schoolName,
        schoolSlug: snapshot.schoolSlug,
        roleName: snapshot.roleName,
        roleSlug: snapshot.roleSlug,
        isActive: true,
      },
      memberships: await this.listMemberships(auth.userId),
      permissions: [...snapshot.permissions].sort(),
    };
  }

  private async buildSession(
    user: User,
    membershipId: string,
    tokens: SessionDto['tokens'],
  ): Promise<SessionDto> {
    // A fresh snapshot is required here: the membership may have been created
    // moments ago in the same request.
    await this.accessControl.invalidateMembership(membershipId);
    const snapshot =
      await this.accessControl.getMembershipSnapshot(membershipId);
    if (!snapshot)
      throw AppException.internal('Membership could not be resolved');

    return {
      tokens,
      user: this.toUserDto(user),
      activeSchool: {
        membershipId: snapshot.membershipId,
        schoolId: snapshot.schoolId,
        schoolName: snapshot.schoolName,
        schoolSlug: snapshot.schoolSlug,
        roleName: snapshot.roleName,
        roleSlug: snapshot.roleSlug,
        isActive: true,
      },
      memberships: await this.listMemberships(user.id),
      permissions: [...snapshot.permissions].sort(),
    };
  }

  private async listMemberships(
    userId: string,
  ): Promise<MembershipSummaryDto[]> {
    // Spans tenants by design: "which schools do I belong to?".
    const memberships = await RequestContext.runAsSystem(() =>
      this.prisma.membership.findMany({
        where: { userId },
        include: { school: true, role: true },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      }),
    );

    return memberships.map((m) => ({
      membershipId: m.id,
      schoolId: m.schoolId,
      schoolName: m.school.name,
      schoolSlug: m.school.slug,
      roleName: m.role.name,
      roleSlug: m.role.slug,
      isActive:
        m.status === MembershipStatus.ACTIVE &&
        m.school.status === SchoolStatus.ACTIVE,
    }));
  }

  private toUserDto(user: User): AuthUserDto {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      emailVerified: user.emailVerifiedAt !== null,
    };
  }
}
