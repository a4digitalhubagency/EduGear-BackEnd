import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserStatus } from '@prisma/client';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
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
import { PlatformLoginDto } from './dto/platform.dto';

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

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revokeRefreshToken(refreshToken);
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
