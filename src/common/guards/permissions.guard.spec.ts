import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AccessControlService,
  MembershipSnapshot,
} from '../../auth/access-control.service';
import { PERMISSIONS } from '../constants/permissions';
import { AuthContext, RequestContext } from '../context/request-context';
import { AppException } from '../errors/app.exception';
import {
  ALLOW_NO_TENANT_KEY,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
} from '../decorators';
import { PermissionsGuard } from './permissions.guard';

describe('PermissionsGuard', () => {
  const auth: AuthContext = {
    userId: 'user-1',
    membershipId: 'membership-1',
    schoolId: 'school-1',
    roleId: 'role-1',
    roleSlug: 'TEACHER',
    email: 'teacher@example.com',
  };

  const snapshot = {
    membershipId: 'membership-1',
    roleId: 'role-1',
    userId: 'user-1',
    permissions: new Set<string>([
      PERMISSIONS.STUDENTS_READ,
      PERMISSIONS.SCHOOL_READ,
    ]),
  } as unknown as MembershipSnapshot;

  const accessControl = {
    getMembershipSnapshot: jest.fn().mockResolvedValue(snapshot),
    hasAllPermissions: (snap: MembershipSnapshot, required: string[]) =>
      required.every((p) => snap.permissions.has(p)),
  } as unknown as AccessControlService;

  function buildContext(request: Record<string, unknown>): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as unknown as ExecutionContext;
  }

  function buildReflector(metadata: Record<string, unknown>): Reflector {
    return {
      getAllAndOverride: (key: string) => metadata[key],
    } as unknown as Reflector;
  }

  it('lets public routes through without a token', async () => {
    const guard = new PermissionsGuard(
      buildReflector({ [IS_PUBLIC_KEY]: true }),
      accessControl,
    );
    await expect(guard.canActivate(buildContext({}))).resolves.toBe(true);
  });

  it('rejects an authenticated request that has no resolved tenant', async () => {
    const guard = new PermissionsGuard(buildReflector({}), accessControl);
    // No RequestContext tenant established.
    await expect(guard.canActivate(buildContext({ auth }))).rejects.toThrow(
      AppException,
    );
  });

  it('allows a tenant-less route when it opts in', async () => {
    const guard = new PermissionsGuard(
      buildReflector({ [ALLOW_NO_TENANT_KEY]: true }),
      accessControl,
    );
    await expect(guard.canActivate(buildContext({ auth }))).resolves.toBe(true);
  });

  it('allows a request holding the required permission', async () => {
    const guard = new PermissionsGuard(
      buildReflector({ [PERMISSIONS_KEY]: [PERMISSIONS.STUDENTS_READ] }),
      accessControl,
    );

    await RequestContext.runWithTenant(auth, async () => {
      await expect(
        guard.canActivate(buildContext({ auth, membership: snapshot })),
      ).resolves.toBe(true);
    });
  });

  it('denies a request missing the required permission and names it', async () => {
    const guard = new PermissionsGuard(
      buildReflector({ [PERMISSIONS_KEY]: [PERMISSIONS.USERS_CREATE] }),
      accessControl,
    );

    await RequestContext.runWithTenant(auth, async () => {
      await expect(
        guard.canActivate(buildContext({ auth, membership: snapshot })),
      ).rejects.toThrow(/users.create/);
    });
  });

  it('requires ALL listed permissions, not just one', async () => {
    const guard = new PermissionsGuard(
      buildReflector({
        [PERMISSIONS_KEY]: [
          PERMISSIONS.STUDENTS_READ,
          PERMISSIONS.STUDENTS_DELETE,
        ],
      }),
      accessControl,
    );

    await RequestContext.runWithTenant(auth, async () => {
      await expect(
        guard.canActivate(buildContext({ auth, membership: snapshot })),
      ).rejects.toThrow(/students.delete/);
    });
  });
});
