import { Injectable, Logger } from '@nestjs/common';
import { MembershipStatus, SchoolStatus, UserStatus } from '@prisma/client';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { RequestContext } from '../common/context/request-context';
import { PermissionKey } from '../common/constants/permissions';
import { MembershipCacheService } from './membership-cache.service';

export interface MembershipSnapshot {
  membershipId: string;
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  schoolId: string;
  schoolSlug: string;
  schoolName: string;
  schoolStatus: SchoolStatus;
  roleId: string;
  roleSlug: string;
  roleName: string;
  membershipStatus: MembershipStatus;
  userStatus: UserStatus;
  tokenVersion: number;
  permissions: Set<string>;
}

/**
 * Resolves "what may this membership do" on every authenticated request.
 *
 * Caching lives in `MembershipCacheService`, which is Redis-backed when
 * `REDIS_URL` is configured — so an invalidation on one instance is seen by all
 * of them. Entries expire after 30s regardless, bounding any missed invalidation.
 */
@Injectable()
export class AccessControlService {
  private readonly logger = new Logger(AccessControlService.name);

  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly cache: MembershipCacheService,
  ) {}

  async getMembershipSnapshot(
    membershipId: string,
  ): Promise<MembershipSnapshot | null> {
    const cached = await this.cache.get(membershipId);
    if (cached) {
      return cached;
    }

    // Authentication happens before a tenant is established, so this lookup is
    // explicitly system-scoped. It is safe: we filter by the membership id that
    // the signed token carried, and every field is re-validated by the caller.
    const membership = await RequestContext.runAsSystem(() =>
      this.prisma.membership.findUnique({
        where: { id: membershipId },
        include: {
          user: true,
          school: true,
          role: { include: { permissions: { include: { permission: true } } } },
        },
      }),
    );

    if (!membership) {
      await this.cache.invalidateMembership(membershipId);
      return null;
    }

    const snapshot: MembershipSnapshot = {
      membershipId: membership.id,
      userId: membership.userId,
      email: membership.user.email,
      firstName: membership.user.firstName,
      lastName: membership.user.lastName,
      schoolId: membership.schoolId,
      schoolSlug: membership.school.slug,
      schoolName: membership.school.name,
      schoolStatus: membership.school.status,
      roleId: membership.roleId,
      roleSlug: membership.role.slug,
      roleName: membership.role.name,
      membershipStatus: membership.status,
      userStatus: membership.user.status,
      tokenVersion: membership.user.tokenVersion,
      permissions: new Set(
        membership.role.permissions.map((rp) => rp.permission.key),
      ),
    };

    await this.cache.set(snapshot);

    return snapshot;
  }

  hasPermission(
    snapshot: MembershipSnapshot,
    permission: PermissionKey,
  ): boolean {
    return snapshot.permissions.has(permission);
  }

  hasAllPermissions(
    snapshot: MembershipSnapshot,
    permissions: PermissionKey[],
  ): boolean {
    return permissions.every((p) => snapshot.permissions.has(p));
  }

  /**
   * Call after any change to a membership, its role, or the owning user.
   * Await it: the next request must not be served a stale snapshot.
   */
  async invalidateMembership(membershipId: string): Promise<void> {
    await this.cache.invalidateMembership(membershipId);
  }

  /** Call after a role's permissions change — affects every member holding it. */
  async invalidateRole(roleId: string): Promise<void> {
    await this.cache.invalidateRole(roleId);
  }

  /** Call on password change / logout-all, which bumps the user's token version. */
  async invalidateUser(userId: string): Promise<void> {
    await this.cache.invalidateUser(userId);
  }

  async clear(): Promise<void> {
    await this.cache.clear();
  }
}
