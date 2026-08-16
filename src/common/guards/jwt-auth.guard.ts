import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import { IS_PUBLIC_KEY } from '../decorators';

/**
 * Applied globally: every route is authenticated unless explicitly marked
 * `@Public()`. Secure-by-default beats remembering to add a guard.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  handleRequest<TUser>(err: unknown, user: TUser, info: unknown): TUser {
    if (err)
      throw err instanceof Error ? err : new Error('Authentication failed');

    if (!user) {
      const name = (info as Error | undefined)?.name;
      if (name === 'TokenExpiredError') {
        throw AppException.unauthorized(
          'Access token has expired',
          ErrorCode.TOKEN_EXPIRED,
        );
      }
      throw AppException.unauthorized(
        'A valid access token is required',
        ErrorCode.UNAUTHENTICATED,
      );
    }

    return user;
  }
}
