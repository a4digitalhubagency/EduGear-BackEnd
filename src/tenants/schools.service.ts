import { Injectable, Logger } from '@nestjs/common';
import { School } from '@prisma/client';
import {
  SYSTEM_ROLE_DEFINITIONS,
  SystemRoleSlug,
} from '../common/constants/roles';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma, TxClient } from '../database/prisma.service';
import { SchoolDto, UpdateSchoolDto } from './dto/school.dto';

@Injectable()
export class SchoolsService {
  private readonly logger = new Logger(SchoolsService.name);

  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  /**
   * Creates a tenant and copies the system role templates into it, so a school
   * can retune its own roles later without touching any other tenant.
   * Must run inside a transaction owned by the caller (registration).
   */
  async provisionSchool(
    tx: TxClient,
    input: {
      name: string;
      email: string;
      phone?: string;
      state?: string;
      city?: string;
    },
  ): Promise<{
    school: School;
    roleIdsBySlug: Record<SystemRoleSlug, string>;
  }> {
    const slug = await this.generateUniqueSlug(tx, input.name);

    const school = await tx.school.create({
      data: {
        name: input.name.trim(),
        slug,
        email: input.email.toLowerCase().trim(),
        phone: input.phone,
        state: input.state,
        city: input.city,
        // ACTIVE from the start: the pilot onboards schools directly. Flip to
        // PENDING here if a manual approval step is introduced.
        status: 'ACTIVE',
      },
    });

    const permissions = await tx.permission.findMany();
    const permissionIdByKey = new Map(permissions.map((p) => [p.key, p.id]));

    const roleIdsBySlug = {} as Record<SystemRoleSlug, string>;

    for (const definition of SYSTEM_ROLE_DEFINITIONS) {
      const role = await tx.role.create({
        data: {
          schoolId: school.id,
          name: definition.name,
          slug: definition.slug,
          description: definition.description,
          isSystem: true,
        },
      });

      const rows = definition.permissions
        .map((key) => permissionIdByKey.get(key))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId }));

      if (rows.length !== definition.permissions.length) {
        // Means the catalogue in the database is behind the code.
        this.logger.warn(
          `Role ${definition.slug} expected ${definition.permissions.length} permissions but matched ${rows.length}`,
        );
      }

      if (rows.length > 0) {
        await tx.rolePermission.createMany({
          data: rows,
          skipDuplicates: true,
        });
      }

      roleIdsBySlug[definition.slug] = role.id;
    }

    return { school, roleIdsBySlug };
  }

  /** Current tenant's profile. The guard supplies the tenant filter. */
  async getCurrentSchool(): Promise<SchoolDto> {
    const schoolId = RequestContext.getTenantId();
    const school = await this.prisma.school.findFirst({
      where: { id: schoolId! },
    });
    if (!school) throw AppException.notFound('School');
    return this.toDto(school);
  }

  async updateCurrentSchool(dto: UpdateSchoolDto): Promise<SchoolDto> {
    const schoolId = RequestContext.getTenantId();
    const school = await this.prisma.school.update({
      where: { id: schoolId! },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.shortName !== undefined ? { shortName: dto.shortName } : {}),
        ...(dto.email !== undefined ? { email: dto.email.toLowerCase() } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.addressLine !== undefined
          ? { addressLine: dto.addressLine }
          : {}),
        ...(dto.city !== undefined ? { city: dto.city } : {}),
        ...(dto.state !== undefined ? { state: dto.state } : {}),
        ...(dto.motto !== undefined ? { motto: dto.motto } : {}),
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
      },
    });
    return this.toDto(school);
  }

  /** Used by the logo endpoints, which own the file lifecycle themselves. */
  async setLogo(logoUrl: string | null): Promise<SchoolDto> {
    const schoolId = RequestContext.getTenantId();
    if (!schoolId) throw AppException.unauthorized();

    await this.prisma.school.update({
      where: { id: schoolId },
      data: { logoUrl },
    });
    return this.getCurrentSchool();
  }

  async listRoles() {
    const roles = await this.prisma.role.findMany({
      orderBy: { name: 'asc' },
      include: {
        permissions: { include: { permission: true } },
        _count: { select: { memberships: true } },
      },
    });

    return roles.map((role) => ({
      id: role.id,
      name: role.name,
      slug: role.slug,
      description: role.description,
      isSystem: role.isSystem,
      memberCount: role._count.memberships,
      permissions: role.permissions.map((rp) => rp.permission.key).sort(),
    }));
  }

  toDto(school: School): SchoolDto {
    return {
      id: school.id,
      slug: school.slug,
      name: school.name,
      shortName: school.shortName,
      email: school.email,
      phone: school.phone,
      addressLine: school.addressLine,
      city: school.city,
      state: school.state,
      country: school.country,
      logoUrl: school.logoUrl,
      motto: school.motto,
      status: school.status,
      timezone: school.timezone,
      currency: school.currency,
      createdAt: school.createdAt,
    };
  }

  private async generateUniqueSlug(
    tx: TxClient,
    name: string,
  ): Promise<string> {
    const base =
      name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 40) || 'school';

    // Slug lookups span tenants by definition, so they run system-scoped.
    return RequestContext.runAsSystem(async () => {
      let candidate = base;
      let suffix = 1;

      // Bounded loop: a handful of collisions at most, then fall back to random.
      while (suffix < 25) {
        const existing = await tx.school.findUnique({
          where: { slug: candidate },
          select: { id: true },
        });
        if (!existing) return candidate;
        suffix += 1;
        candidate = `${base}-${suffix}`;
      }

      return `${base}-${Math.random().toString(36).slice(2, 8)}`;
    });
  }
}
