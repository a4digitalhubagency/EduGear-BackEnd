import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { PlatformRole } from '@prisma/client';
import { PermissionKey } from '../constants/permissions';
import { AuthContext, PlatformContext } from '../context/request-context';

export const IS_PUBLIC_KEY = 'edugear:isPublic';
export const PERMISSIONS_KEY = 'edugear:permissions';
export const ALLOW_NO_TENANT_KEY = 'edugear:allowNoTenant';
export const PLATFORM_ROLE_KEY = 'edugear:platformRole';

/** Opts a route out of authentication (login, registration, health, docs). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Requires ALL listed permissions. Authorization is never expressed as a role
 * check in a controller — always as the permission the action actually needs.
 */
export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * For authenticated routes that legitimately have no active tenant, e.g.
 * listing the schools a user belongs to before one is selected.
 */
export const AllowNoTenant = () => SetMetadata(ALLOW_NO_TENANT_KEY, true);

/** Injects the verified auth context (never client-supplied data). */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthContext | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ auth?: AuthContext }>();
    const auth = request.auth;
    if (!auth) return undefined;
    return field ? auth[field] : auth;
  },
);

/**
 * Marks a route as belonging to A4's own staff rather than a school's, and names
 * the platform roles that may call it. A school token can never satisfy one of
 * these, and a platform token can never satisfy an ordinary route.
 */
export const RequirePlatformRole = (...roles: PlatformRole[]) =>
  SetMetadata(PLATFORM_ROLE_KEY, roles);

/** Injects the platform operator behind a platform route. */
export const CurrentPlatformAdmin = createParamDecorator(
  (field: keyof PlatformContext | undefined, ctx: ExecutionContext) => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ platform?: PlatformContext }>();
    const platform = request.platform;
    if (!platform) return undefined;
    return field ? platform[field] : platform;
  },
);

/** Injects the active tenant id resolved from the access token. */
export const CurrentSchool = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ auth?: AuthContext }>();
    return request.auth?.schoolId;
  },
);
