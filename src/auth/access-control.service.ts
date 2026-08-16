import { Injectable, Logger } from '@nestjs/common';
import { MembershipStatus, SchoolStatus, UserStatus } from '@prisma/client';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { RequestContext } from '../common/context/request-context';
import { PermissionKey } from '../common/constants/permissions';

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
 * The MVP has no Redis, so this is an in-process TTL cache. Consequences are
 * accepted deliberately: a permission change is visible immediately on the
 * instance that made it (we invalidate), and within CACHE_TTL_MS on any other.
 * Swap the Map for Redis when a second instance appears.
 */
@Injectable()
export class AccessControlService {
  private static readonly CACHE_TTL_MS = 30_000;
  private readonly logger = new Logger(AccessControlService.name);
  private readonly cache = new Map<
    string,
    { expiresAt: number; snapshot: MembershipSnapshot }
  >();

  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  async getMembershipSnapshot(
    membershipId: string,
  ): Promise<MembershipSnapshot | null> {
    const cached = this.cache.get(membershipId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.snapshot;
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
      this.cache.delete(membershipId);
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

    this.cache.set(membershipId, {
      expiresAt: Date.now() + AccessControlService.CACHE_TTL_MS,
      snapshot,
    });

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

  /** Call after any change to a membership, its role, or the owning user. */
  invalidateMembership(membershipId: string): void {
    this.cache.delete(membershipId);
  }

  /** Call after a role's permissions change — affects every member holding it. */
  invalidateRole(roleId: string): void {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.snapshot.roleId === roleId) {
        this.cache.delete(key);
      }
    }
  }

  /** Call on password change / logout-all, which bumps the user's token version. */
  invalidateUser(userId: string): void {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.snapshot.userId === userId) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }
}
