import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { PERMISSIONS } from '../common/constants/permissions';
import { RequirePermissions } from '../common/decorators';
import { paginate, PaginatedDto } from '../common/dto/pagination.dto';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { AuditLogDto, QueryAuditLogsDto } from './dto/query-audit-logs.dto';

@ApiTags('Audit')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  @Get()
  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  @ApiOperation({ summary: 'List audit log entries for the current school' })
  @ApiOkResponse({ description: 'Paginated audit trail' })
  async list(
    @Query() query: QueryAuditLogsDto,
  ): Promise<PaginatedDto<AuditLogDto>> {
    // No schoolId filter here on purpose — the Prisma tenant guard adds it.
    const where: Prisma.AuditLogWhereInput = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { action: { contains: query.search, mode: 'insensitive' } },
              { description: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: query.sortOrder },
        skip: query.skip,
        take: query.limit,
        include: {
          actor: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    const data: AuditLogDto[] = rows.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      description: row.description,
      metadata: row.metadata,
      ipAddress: row.ipAddress,
      requestId: row.requestId,
      createdAt: row.createdAt,
      actor: row.actor,
    }));

    return paginate(data, total, query.page, query.limit);
  }
}
