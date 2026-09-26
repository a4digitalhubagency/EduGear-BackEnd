import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AccessControlService,
  MembershipSnapshot,
} from '../../auth/access-control.service';
import { PermissionKey } from '../constants/permissions';
import { PlatformRole } from '@prisma/client';
import {
  AuthContext,
  PlatformContext,
  RequestContext,
} from '../context/request-context';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import {
  ALLOW_NO_TENANT_KEY,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  PLATFORM_ROLE_KEY,
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

    const request = context.switchToHttp().getRequest<{
      auth?: AuthContext;
      membership?: MembershipSnapshot;
      platform?: PlatformContext;
    }>();

    const platformRoles = this.reflector.getAllAndOverride<PlatformRole[]>(
      PLATFORM_ROLE_KEY,
      [context.getHandler(), context.getClass()],
    );

    // The two scopes are mutually exclusive, checked in both directions: a
    // platform route refuses a school token, and every ordinary route refuses a
    // platform one. Neither can be reached by holding the other.
    if (platformRoles) {
      return this.allowPlatform(request.platform, platformRoles);
    }
    if (request.platform) {
      throw AppException.forbidden(
        'A platform session cannot be used on a school route',
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

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

  /**
   * Platform routes have no tenant by design, so the tenant check above does not
   * apply to them. Authority is the PlatformAdmin row's role and nothing else.
   */
  private allowPlatform(
    platform: PlatformContext | undefined,
    allowed: PlatformRole[],
  ): boolean {
    if (!platform) {
      // Deliberately not "you need a platform login": the existence of this
      // surface is not something a school's token should be able to confirm.
      throw AppException.notFound('Resource');
    }

    if (!allowed.includes(platform.role as PlatformRole)) {
      throw AppException.forbidden(
        `This action needs platform role: ${allowed.join(' or ')}`,
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    return true;
  }
}
