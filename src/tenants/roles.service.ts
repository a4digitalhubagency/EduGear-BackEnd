import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessControlService } from '../auth/access-control.service';
import {
  PERMISSIONS,
  PermissionKey,
  PERMISSION_DESCRIPTIONS,
} from '../common/constants/permissions';
import { SYSTEM_ROLES } from '../common/constants/roles';
import { AuthContext, RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma, TxClient } from '../database/prisma.service';
import { RoleDto } from './dto/school.dto';
import {
  CreateRoleDto,
  ReassignMembersDto,
  SetRolePermissionsDto,
  UpdateRoleDto,
} from './dto/role.dto';

const WITH_DETAIL = {
  permissions: { include: { permission: true } },
  _count: { select: { memberships: true } },
} satisfies Prisma.RoleInclude;

type RoleRow = Prisma.RoleGetPayload<{ include: typeof WITH_DETAIL }>;

const ALL_PERMISSION_KEYS = new Set<string>(Object.values(PERMISSIONS));

/**
 * Roles a school can retune, and the one rule that keeps that safe.
 *
 * **You cannot grant a permission you do not hold** — not to a new role, not to
 * an existing one, and not by assigning a role to somebody. Without it, any
 * account that can manage staff can write itself a role with every permission,
 * which is escalation dressed up as administration. And **nobody changes their
 * own role**: the check above would allow it, but it is how one careless grant
 * becomes permanent.
 *
 * The PROPRIETOR role is the recovery path, so its permissions are fixed and it
 * cannot be deleted. Since it always holds every permission and a school always
 * has an active proprietor, a school can never lock itself out of its own
 * administration by editing other roles.
 */
@Injectable()
export class RolesService {
  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly accessControl: AccessControlService,
  ) {}

  async list(): Promise<RoleDto[]> {
    const roles = await this.prisma.role.findMany({
      include: WITH_DETAIL,
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
    return roles.map((role) => this.toDto(role));
  }

  async findOne(id: string): Promise<RoleDto> {
    return this.toDto(await this.getOrThrow(id));
  }

  async create(dto: CreateRoleDto, auth: AuthContext): Promise<RoleDto> {
    const requested = dto.copyFromRoleId
      ? (await this.getOrThrow(dto.copyFromRoleId)).permissions.map(
          (row) => row.permission.key,
        )
      : (dto.permissions ?? []);

    const permissions = await this.assertMayGrant(requested, auth);
    await this.assertNameFree(dto.name);
    const slug = await this.uniqueSlug(dto.name);

    const created = await this.prisma.$transaction(async (tx) => {
      const role = await tx.role.create({
        data: {
          // Prisma's types require the tenant column on create. Supplying it is
          // safe: the guard rejects any value other than the active tenant.
          schoolId: auth.schoolId,
          name: dto.name,
          slug,
          description: dto.description ?? null,
          isSystem: false,
        },
      });
      await this.writePermissions(tx, role.id, permissions);
      return role.id;
    });

    return this.findOne(created);
  }

  /** Name and description only; permissions have their own endpoint. */
  async update(id: string, dto: UpdateRoleDto): Promise<RoleDto> {
    const existing = await this.getOrThrow(id);

    if (dto.name && dto.name !== existing.name) {
      if (existing.isSystem) {
        throw AppException.conflict(
          `${existing.name} is a standard role and cannot be renamed. Create your own role instead.`,
        );
      }
      await this.assertNameFree(dto.name);
    }

    await this.prisma.role.update({
      where: { id },
      data: { name: dto.name, description: dto.description },
    });
    return this.findOne(id);
  }

  /**
   * Replaces a role's permissions wholesale. Everyone holding the role is
   * affected, so their cached snapshots are dropped immediately — otherwise the
   * change would take up to 30 seconds to bite.
   */
  async setPermissions(
    id: string,
    dto: SetRolePermissionsDto,
    auth: AuthContext,
  ): Promise<{ role: RoleDto; added: string[]; removed: string[] }> {
    const existing = await this.getOrThrow(id);

    if (existing.slug === SYSTEM_ROLES.PROPRIETOR) {
      throw AppException.conflict(
        'The proprietor role always holds every permission — it is how a school recovers from any other change.',
      );
    }

    const permissions = await this.assertMayGrant(dto.permissions, auth);
    const before = new Set(
      existing.permissions.map((row) => row.permission.key),
    );
    const after = new Set(permissions.map((row) => row.key));

    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await this.writePermissions(tx, id, permissions);
    });

    // Every holder of this role has a stale snapshot; drop them all.
    await this.accessControl.invalidateRole(id);

    return {
      role: await this.findOne(id),
      added: [...after].filter((key) => !before.has(key)).sort(),
      removed: [...before].filter((key) => !after.has(key)).sort(),
    };
  }

  async remove(id: string): Promise<void> {
    const existing = await this.getOrThrow(id);

    if (existing.isSystem) {
      throw AppException.conflict(
        `${existing.name} is a standard role and cannot be deleted. You can change its permissions instead.`,
      );
    }
    // Memberships restrict their role in the schema; refuse with the count
    // rather than letting the database raise a foreign-key error.
    if (existing._count.memberships > 0) {
      throw AppException.conflict(
        `${existing.name} is held by ${existing._count.memberships} member(s) of staff. Move them to another role first.`,
      );
    }

    await this.prisma.role.delete({ where: { id } });
  }

  /** Moves every member of one role to another, then the caller can delete it. */
  async reassignMembers(
    id: string,
    dto: ReassignMembersDto,
    auth: AuthContext,
  ): Promise<{ moved: number }> {
    const from = await this.getOrThrow(id);
    const to = await this.getOrThrow(dto.toRoleId);

    if (from.id === to.id) {
      throw AppException.badRequest(
        'Choose a different role to move members to',
        ErrorCode.VALIDATION_ERROR,
      );
    }
    const members = await this.prisma.membership.findMany({
      where: { roleId: id },
      select: { id: true, userId: true },
    });
    // Checked before the target role: moving your own membership is a change
    // to your own access level whatever you are moving it to, and that is the
    // fact worth telling the caller.
    if (members.some((member) => member.userId === auth.userId)) {
      throw AppException.forbidden(
        'You cannot move your own membership between roles. Ask another administrator.',
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }
    await this.assertMayAssign(to, auth);
    if (from.slug === SYSTEM_ROLES.PROPRIETOR) {
      throw AppException.conflict(
        'A school must keep its proprietors. Move them one at a time instead.',
      );
    }

    await this.prisma.membership.updateMany({
      where: { roleId: id },
      data: { roleId: to.id },
    });
    for (const member of members) {
      await this.accessControl.invalidateMembership(member.id);
    }

    return { moved: members.length };
  }

  // ---------------------------------------------------------------------------
  // Shared with user management
  // ---------------------------------------------------------------------------

  /**
   * May the caller put somebody into this role? Only if the role grants
   * nothing the caller lacks. Used by role assignment and by invitations.
   */
  async assertMayAssign(
    role: RoleRow | string,
    auth: AuthContext,
  ): Promise<void> {
    const resolved =
      typeof role === 'string' ? await this.getOrThrow(role) : role;
    let keys = resolved.permissions.map((row) => row.permission.key);

    // portal.access is the one permission no member of staff holds — not even
    // the proprietor — because it marks the parent role, and the portal still
    // demands a guardian link behind it. Comparing it would stop anyone from
    // ever inviting a parent. It is ignored only for the standard Parent role;
    // any other role carrying it is refused, which role creation prevents.
    if (keys.includes(PERMISSIONS.PORTAL_ACCESS)) {
      if (resolved.slug !== SYSTEM_ROLES.PARENT || !resolved.isSystem) {
        throw AppException.forbidden(
          `${resolved.name} carries parent portal access, which only the standard Parent role may have`,
          ErrorCode.INSUFFICIENT_PERMISSIONS,
        );
      }
      keys = keys.filter((key) => key !== PERMISSIONS.PORTAL_ACCESS);
    }

    await this.assertMayGrant(
      keys,
      auth,
      `You cannot grant the ${resolved.name} role because it includes permissions you do not hold`,
    );
  }

  /** Nobody edits their own access level, however senior they are. */
  assertNotSelf(targetUserId: string, auth: AuthContext): void {
    if (targetUserId === auth.userId) {
      throw AppException.forbidden(
        'You cannot change your own role. Ask another administrator to do it.',
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }
  }

  // ---------------------------------------------------------------------------

  /** Validates the keys, then checks them against what the caller holds. */
  private async assertMayGrant(
    keys: string[],
    auth: AuthContext,
    message?: string,
  ): Promise<{ id: string; key: string }[]> {
    const requested = [...new Set(keys.map((key) => key.trim()))].filter(
      Boolean,
    );

    const unknown = requested.filter((key) => !ALL_PERMISSION_KEYS.has(key));
    if (unknown.length > 0) {
      throw AppException.badRequest(
        `Unknown permission(s): ${unknown.join(', ')}`,
        ErrorCode.VALIDATION_ERROR,
      );
    }
    // Portal access comes from being a parent, not from a staff role: granting
    // it here would produce a login that the portal itself refuses.
    if (requested.includes(PERMISSIONS.PORTAL_ACCESS)) {
      throw AppException.badRequest(
        'Parent portal access comes from linking a parent record, not from a role',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const snapshot = await this.accessControl.getMembershipSnapshot(
      auth.membershipId,
    );
    const held = snapshot?.permissions ?? new Set<string>();
    const missing = requested.filter((key) => !held.has(key));
    if (missing.length > 0) {
      throw AppException.forbidden(
        `${message ?? 'You cannot grant permissions you do not hold yourself'}: ${missing
          .map((key) => PERMISSION_DESCRIPTIONS[key as PermissionKey] ?? key)
          .join(', ')}`,
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    const rows = await RequestContext.runAsSystem(() =>
      this.prisma.permission.findMany({
        where: { key: { in: requested } },
        select: { id: true, key: true },
      }),
    );
    return rows;
  }

  private async writePermissions(
    tx: TxClient,
    roleId: string,
    permissions: { id: string }[],
  ): Promise<void> {
    if (permissions.length === 0) return;
    await tx.rolePermission.createMany({
      data: permissions.map((permission) => ({
        roleId,
        permissionId: permission.id,
      })),
    });
  }

  private async getOrThrow(id: string): Promise<RoleRow> {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: WITH_DETAIL,
    });
    if (!role) throw AppException.notFound('Role');
    return role;
  }

  private async assertNameFree(name: string): Promise<void> {
    const clash = await this.prisma.role.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (clash) {
      throw AppException.duplicate(`A role named "${name}" already exists`);
    }
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base =
      name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'ROLE';

    // System slugs are reserved: code looks roles up by them.
    const reserved = new Set<string>(Object.values(SYSTEM_ROLES));
    let candidate = reserved.has(base) ? `${base}_CUSTOM` : base;

    for (let suffix = 2; ; suffix++) {
      const taken = await this.prisma.role.findFirst({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
      candidate = `${base}_${suffix}`;
    }
  }

  private toDto(role: RoleRow): RoleDto {
    return {
      id: role.id,
      name: role.name,
      slug: role.slug,
      description: role.description,
      isSystem: role.isSystem,
      memberCount: role._count.memberships,
      permissions: role.permissions.map((row) => row.permission.key).sort(),
    };
  }
}
