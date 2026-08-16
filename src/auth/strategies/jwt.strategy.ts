import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { MembershipStatus, SchoolStatus, UserStatus } from '@prisma/client';
import { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppConfig } from '../../config/configuration';
import {
  AuthContext,
  RequestContext,
} from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  AccessControlService,
  MembershipSnapshot,
} from '../access-control.service';
import { AccessTokenPayload } from '../token.types';

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
    req: Request & { auth?: AuthContext; membership?: MembershipSnapshot },
    payload: AccessTokenPayload,
  ): Promise<AuthContext> {
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
}
