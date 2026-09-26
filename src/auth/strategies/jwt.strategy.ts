import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { MembershipStatus, SchoolStatus, UserStatus } from '@prisma/client';
import { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppConfig } from '../../config/configuration';
import {
  AuthContext,
  PlatformContext,
  RequestContext,
} from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  AccessControlService,
  MembershipSnapshot,
} from '../access-control.service';
import { PlatformAdminService } from '../../platform/platform-admin.service';
import { PlatformTokenPayload, TokenPayload } from '../token.types';

/**
 * Verifies the access token, then re-checks everything that could have changed
 * since it was issued: user status, membership status, school status and token
 * version. The tenant for the request comes from the membership row — never
 * from a header or body field supplied by the client.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly accessControl: AccessControlService,
    private readonly platformAdmins: PlatformAdminService,
  ) {
    const jwt = config.get('jwt', { infer: true });
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwt.accessSecret,
      issuer: jwt.issuer,
      audience: jwt.audience,
      passReqToCallback: true,
    });
  }

  async validate(
    req: Request & {
      auth?: AuthContext;
      membership?: MembershipSnapshot;
      platform?: PlatformContext;
    },
    payload: TokenPayload,
  ): Promise<AuthContext | PlatformContext> {
    // The two scopes are resolved by entirely separate paths and never share a
    // lookup, so no bug can quietly promote a school token to a platform one.
    if (payload.typ === 'platform') {
      return this.validatePlatform(req, payload);
    }

    if (payload.typ !== 'access') {
      throw AppException.unauthorized(
        'Invalid token type',
        ErrorCode.TOKEN_INVALID,
      );
    }

    const snapshot = await this.accessControl.getMembershipSnapshot(
      payload.mid,
    );
    if (!snapshot || snapshot.userId !== payload.sub) {
      throw AppException.unauthorized(
        'Session is no longer valid',
        ErrorCode.TOKEN_INVALID,
      );
    }

    if (snapshot.tokenVersion !== payload.ver) {
      throw AppException.unauthorized(
        'Session has been invalidated, please sign in again',
        ErrorCode.TOKEN_INVALID,
      );
    }

    if (snapshot.userStatus !== UserStatus.ACTIVE) {
      throw AppException.forbidden(
        'This account is not active',
        ErrorCode.ACCOUNT_INACTIVE,
      );
    }

    if (snapshot.membershipStatus !== MembershipStatus.ACTIVE) {
      throw AppException.forbidden(
        'Your access to this school is not active',
        ErrorCode.MEMBERSHIP_INACTIVE,
      );
    }

    if (snapshot.schoolStatus !== SchoolStatus.ACTIVE) {
      throw AppException.forbidden(
        'This school account is not active',
        ErrorCode.SCHOOL_INACTIVE,
      );
    }

    const auth: AuthContext = {
      userId: snapshot.userId,
      membershipId: snapshot.membershipId,
      schoolId: snapshot.schoolId,
      roleId: snapshot.roleId,
      roleSlug: snapshot.roleSlug,
      email: snapshot.email,
    };

    // Feeds the Prisma tenant guard for the rest of the request.
    RequestContext.setAuth(auth);
    req.auth = auth;
    req.membership = snapshot;

    return auth;
  }

  /**
   * A4's own staff. No membership is loaded and no tenant is set, so the Prisma
   * guard still has nothing to scope by — a platform route reads across schools
   * only where it says `runAsSystem` out loud.
   */
  private async validatePlatform(
    req: Request & { platform?: PlatformContext },
    payload: PlatformTokenPayload,
  ): Promise<PlatformContext> {
    const admin = await this.platformAdmins.snapshot(payload.pid);

    if (!admin || admin.userId !== payload.sub) {
      throw AppException.unauthorized(
        'Session is no longer valid',
        ErrorCode.TOKEN_INVALID,
      );
    }

    if (admin.tokenVersion !== payload.ver) {
      throw AppException.unauthorized(
        'Session has been invalidated, please sign in again',
        ErrorCode.TOKEN_INVALID,
      );
    }

    if (admin.disabledAt) {
      throw AppException.forbidden(
        'Platform access has been revoked',
        ErrorCode.ACCOUNT_INACTIVE,
      );
    }

    if (admin.userStatus !== UserStatus.ACTIVE) {
      throw AppException.forbidden(
        'This account is not active',
        ErrorCode.ACCOUNT_INACTIVE,
      );
    }

    const platform: PlatformContext = {
      userId: admin.userId,
      platformAdminId: admin.id,
      role: admin.role,
      email: admin.email,
    };

    RequestContext.setPlatform(platform);
    req.platform = platform;

    return platform;
  }
}
