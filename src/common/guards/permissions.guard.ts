import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AccessControlService,
  MembershipSnapshot,
} from '../../auth/access-control.service';
import { PermissionKey } from '../constants/permissions';
import { AuthContext, RequestContext } from '../context/request-context';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import {
  ALLOW_NO_TENANT_KEY,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
} from '../decorators';

/**
 * Second half of the authorization story (the first is authentication).
 * Also the last line of tenant defence: it refuses any authenticated request
 * that somehow reached a handler without a resolved tenant.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessControl: AccessControlService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<{ auth?: AuthContext; membership?: MembershipSnapshot }>();

    if (!request.auth) {
      throw AppException.unauthorized();
    }

    const allowNoTenant = this.reflector.getAllAndOverride<boolean>(
      ALLOW_NO_TENANT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!allowNoTenant && !RequestContext.getTenantId()) {
      throw AppException.forbidden(
        'No active school for this session',
        ErrorCode.TENANT_ACCESS_DENIED,
      );
    }

    const required = this.reflector.getAllAndOverride<PermissionKey[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) return true;

    const snapshot =
      request.membership ??
      (await this.accessControl.getMembershipSnapshot(
        request.auth.membershipId,
      ));

    if (
      !snapshot ||
      !this.accessControl.hasAllPermissions(snapshot, required)
    ) {
      const missing = required.filter((p) => !snapshot?.permissions.has(p));
      throw new AppException(
        403,
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Missing required permission${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      );
    }

    return true;
  }
}
