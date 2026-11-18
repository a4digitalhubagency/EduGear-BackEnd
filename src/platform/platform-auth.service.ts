import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserStatus, VerificationTokenType } from '@prisma/client';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../notifications/email.service';
import { PasswordService } from '../auth/password.service';
import { SessionMeta, TokenService } from '../auth/token.service';
import { IssuedTokens } from '../auth/token.types';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { AppConfig } from '../config/configuration';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { PlatformAdminService } from './platform-admin.service';
import { ChangePasswordDto } from '../auth/dto/auth.dto';
import { ChangeEmailDto, PlatformLoginDto } from './dto/platform.dto';

/** Cost of a real verify, spent on a miss so timing does not reveal the account. */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$J6ZQjKvVQxL2X8mGpQkzKQxN9yZ6vLmQqPqYxJ2kW8A';

export interface PlatformSessionDto {
  admin: {
    id: string;
    email: string;
    role: string;
  };
  tokens: IssuedTokens;
}

/**
 * Signing in as A4, not as a school.
 *
 * Kept off `/auth/login` deliberately. That endpoint resolves a membership and
 * would fail for an operator who has none, and more importantly the two doors
 * should stay separate so stronger checks can be put on this one later without
 * touching how thousands of teachers sign in.
 */
@Injectable()
export class PlatformAuthService {
  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly admins: PlatformAdminService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async login(
    dto: PlatformLoginDto,
    meta: SessionMeta,
  ): Promise<PlatformSessionDto> {
    const policy = this.config.get('auth', { infer: true });

    const user = await RequestContext.runAsSystem(() =>
      this.prisma.user.findUnique({
        where: { email: dto.email },
        include: { platformAdmin: true },
      }),
    );

    // One message for every failure below, so this endpoint cannot be used to
    // discover who at A4 has an operator account.
    const deny = () =>
      AppException.unauthorized(
        'Invalid email or password',
        ErrorCode.INVALID_CREDENTIALS,
      );

    if (!user) {
      await this.passwords.verify(DUMMY_HASH, dto.password);
      await this.recordFailure(null, dto.email, 'unknown email');
      throw deny();
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
        policy.maxFailedLoginAttempts,
        policy.accountLockMinutes,
      );
      throw deny();
    }

    // Checked only after the password, so a correct-password probe is the only
    // way to learn anything — and that already means the account is theirs.
    if (!user.platformAdmin || user.platformAdmin.disabledAt) {
      await this.recordFailure(user.id, dto.email, 'not a platform admin');
      throw deny();
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw AppException.forbidden(
        'This account is not active',
        ErrorCode.ACCOUNT_INACTIVE,
      );
    }

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

    const tokens = await this.tokens.issuePlatformTokens({
      userId: user.id,
      platformAdminId: user.platformAdmin.id,
      tokenVersion: user.tokenVersion,
      meta,
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.PLATFORM_LOGIN_SUCCEEDED,
      entityType: 'PlatformAdmin',
      entityId: user.platformAdmin.id,
      description: `${user.email} signed in to the platform console`,
      schoolId: null,
      actorUserId: user.id,
      membershipId: null,
    });

    return {
      admin: {
        id: user.platformAdmin.id,
        email: user.email,
        role: user.platformAdmin.role,
      },
      tokens,
    };
  }

  /** The operator's own record, for the console to render who is signed in. */
  async me() {
    const platform = RequestContext.getPlatform();
    if (!platform) throw AppException.unauthorized();

    const admin = await this.admins.snapshot(platform.platformAdminId);
    if (!admin) throw AppException.unauthorized();

    return {
      id: admin.id,
      email: admin.email,
      role: admin.role,
    };
  }

  /**
   * Keeps a console session alive past the fifteen-minute access token.
   *
   * Before this, platform login handed back a refresh token that nothing could
   * exchange — `rotateRefreshToken` requires a membership, and an operator has
   * none — so the console signed itself out every quarter of an hour and the
   * retry failed complaining about school context.
   *
   * Everything that gates a login is re-checked here, not just the token's
   * signature. A refresh token lives for thirty days; platform access can be
   * revoked in a second, and revocation that only bites at the end of that
   * window is not revocation. The admin snapshot is deliberately uncached for
   * the same reason.
   */
  async refresh(
    refreshToken: string,
    meta: SessionMeta,
  ): Promise<PlatformSessionDto> {
    const stored = await this.tokens.consumePlatformRefreshToken(refreshToken);

    const user = await RequestContext.runAsSystem(() =>
      this.prisma.user.findUnique({
        where: { id: stored.userId },
        include: { platformAdmin: true },
      }),
    );

    if (!user || !user.platformAdmin || user.platformAdmin.disabledAt) {
      // Access was taken away after this token was issued.
      await this.tokens.revokeFamily(stored.familyId);
      throw AppException.unauthorized(
        'Platform access has been revoked',
        ErrorCode.TOKEN_INVALID,
      );
    }

    if (user.status !== UserStatus.ACTIVE) {
      await this.tokens.revokeFamily(stored.familyId);
      throw AppException.forbidden(
        'This account is not active',
        ErrorCode.ACCOUNT_INACTIVE,
      );
    }

    const tokens = await this.tokens.issuePlatformTokens({
      userId: user.id,
      platformAdminId: user.platformAdmin.id,
      tokenVersion: user.tokenVersion,
      meta,
      // Same family, so presenting the retired token afterwards is detected
      // as reuse rather than read as an unrelated session.
      familyId: stored.familyId,
    });

    // Retired only once the replacement exists.
    await this.tokens.revokeRefreshToken(refreshToken);

    return {
      admin: {
        id: user.platformAdmin.id,
        email: user.email,
        role: user.platformAdmin.role,
      },
      tokens,
    };
  }

  /**
   * Moves an operator account to a different address, in two steps.
   *
   * The confirmation goes to the address being moved **to**, never the one
   * being moved from. That is the whole safety of it: a mistyped address
   * produces a link nobody can open, and the account quietly keeps the email
   * it already had. Confirming at the current address would confirm the typo
   * instead, and strand the only account that can administer the platform.
   *
   * The current password is required, because an address is how an account is
   * recovered — changing it is a takeover, not a preference.
   */
  async requestEmailChange(dto: ChangeEmailDto): Promise<void> {
    const platform = RequestContext.getPlatform();
    if (!platform) throw AppException.unauthorized();

    const user = await RequestContext.runAsSystem(() =>
      this.prisma.user.findUnique({ where: { id: platform.userId } }),
    );
    if (!user) throw AppException.unauthorized();

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

    const newEmail = dto.newEmail.trim().toLowerCase();
    if (newEmail === user.email) {
      throw AppException.badRequest(
        'That is already this account\u2019s email',
      );
    }
    await this.assertEmailFree(newEmail);

    const { passwordResetTtlMinutes } = this.config.get('auth', {
      infer: true,
    });
    const { raw } = await this.tokens.createVerificationToken({
      userId: user.id,
      type: VerificationTokenType.EMAIL_CHANGE,
      ttlMs: this.tokens.ttlMinutes(passwordResetTtlMinutes),
      // The destination rides with the token rather than on the user, so an
      // abandoned request leaves no half-changed row behind.
      metadata: { newEmail },
    });

    await this.email.sendPlatformEmailChange({
      to: newEmail,
      firstName: user.firstName,
      token: raw,
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.PLATFORM_EMAIL_CHANGE_REQUESTED,
      entityType: 'PlatformAdmin',
      entityId: platform.platformAdminId,
      description: `${user.email} asked to move this operator account to ${newEmail}`,
      schoolId: null,
      actorUserId: user.id,
      membershipId: null,
    });
  }

  /**
   * Opening the link is what actually moves the account.
   *
   * Everything is re-checked here rather than trusted from the request that
   * sent the link: the address may have been taken in between, and platform
   * access may have been revoked. The old address is then told, because that
   * notice is the only warning the real owner gets if someone with their
   * password moved the account somewhere they control.
   */
  async confirmEmailChange(token: string): Promise<void> {
    const record = await this.tokens.consumeVerificationToken(
      token,
      VerificationTokenType.EMAIL_CHANGE,
    );

    const newEmail = this.emailFromMetadata(record.metadata);

    const user = await RequestContext.runAsSystem(() =>
      this.prisma.user.findUnique({
        where: { id: record.userId },
        include: { platformAdmin: true },
      }),
    );
    if (!user || !user.platformAdmin || user.platformAdmin.disabledAt) {
      throw AppException.unauthorized(
        'Platform access has been revoked',
        ErrorCode.TOKEN_INVALID,
      );
    }

    const previousEmail = user.email;
    // Checked again: the link may have sat in an inbox while somebody else
    // took the address.
    await this.assertEmailFree(newEmail);

    await RequestContext.runAsSystem(() =>
      this.prisma.user.update({
        where: { id: user.id },
        data: { email: newEmail, emailVerifiedAt: new Date() },
      }),
    );

    await this.email.sendPlatformEmailChanged({
      to: previousEmail,
      firstName: user.firstName,
      newEmail,
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.PLATFORM_EMAIL_CHANGED,
      entityType: 'PlatformAdmin',
      entityId: user.platformAdmin.id,
      description: `Operator account moved from ${previousEmail} to ${newEmail}`,
      metadata: { previousEmail, newEmail },
      schoolId: null,
      actorUserId: user.id,
      membershipId: null,
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * `User.email` is unique across the whole product, so any existing account
   * blocks the move — and one belonging to a member of staff blocks it for a
   * second reason: the two populations must not overlap, which is the security
   * argument this whole surface rests on.
   */
  private async assertEmailFree(email: string): Promise<void> {
    const existing = await RequestContext.runAsSystem(() =>
      this.prisma.user.findUnique({ where: { email } }),
    );
    if (existing) {
      throw AppException.conflict(
        'That email already belongs to an EduGear account',
      );
    }
  }

  private emailFromMetadata(metadata: unknown): string {
    const email =
      typeof metadata === 'object' && metadata !== null
        ? (metadata as { newEmail?: unknown }).newEmail
        : undefined;

    if (typeof email !== 'string' || email.length === 0) {
      throw AppException.badRequest(
        'This link is invalid',
        ErrorCode.TOKEN_INVALID,
      );
    }
    return email;
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revokeRefreshToken(refreshToken);
  }

  /**
   * An operator changing their own password.
   *
   * `/auth/change-password` cannot serve this: it resolves an `AuthContext`,
   * which a platform session has none of, so the permissions guard turns a
   * platform token away with 403 before the handler runs. Rather than teach
   * that route about two kinds of caller, the platform surface keeps its own —
   * the same reason the two logins are separate doors.
   *
   * Bumping `tokenVersion` is what revokes the sessions: the strategy's
   * platform branch compares it on every request, and the admin snapshot is
   * deliberately uncached, so the operator's other sessions die on their next
   * call rather than when a cache expires.
   */
  async changePassword(dto: ChangePasswordDto): Promise<void> {
    const platform = RequestContext.getPlatform();
    if (!platform) throw AppException.unauthorized();

    this.passwords.assertMeetsPolicy(dto.newPassword);

    const user = await RequestContext.runAsSystem(() =>
      this.prisma.user.findUnique({ where: { id: platform.userId } }),
    );
    if (!user) throw AppException.unauthorized();

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

    await this.audit.record({
      action: AUDIT_ACTIONS.PLATFORM_PASSWORD_CHANGED,
      entityType: 'PlatformAdmin',
      entityId: platform.platformAdminId,
      description: `${user.email} changed their platform password`,
      schoolId: null,
      actorUserId: user.id,
      membershipId: null,
    });
  }

  // ---------------------------------------------------------------------------

  private async registerFailedAttempt(
    user: { id: string; failedLoginAttempts: number; lockedUntil: Date | null },
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
        : AUDIT_ACTIONS.PLATFORM_LOGIN_FAILED,
      entityType: 'User',
      entityId: user.id,
      schoolId: null,
      actorUserId: user.id,
      membershipId: null,
      metadata: { attempts, surface: 'platform' },
    });
  }

  private async recordFailure(
    userId: string | null,
    email: string,
    reason: string,
  ): Promise<void> {
    await this.audit.record({
      action: AUDIT_ACTIONS.PLATFORM_LOGIN_FAILED,
      description: `Platform login refused: ${reason}`,
      metadata: { email },
      schoolId: null,
      actorUserId: userId,
      membershipId: null,
    });
  }
}
