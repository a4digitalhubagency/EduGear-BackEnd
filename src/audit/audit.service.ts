import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContext } from '../common/context/request-context';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { AuditAction } from './audit-actions';

export interface AuditEntry {
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  /** Explicit tenant, for events recorded outside a tenant-scoped request. */
  schoolId?: string | null;
  /** Explicit actor, for events where no session exists yet (e.g. login). */
  actorUserId?: string | null;
  membershipId?: string | null;
}

/** Keys that must never be persisted, whatever a caller passes in. */
const REDACTED_KEYS = [
  'password',
  'passwordhash',
  'newpassword',
  'currentpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'apikey',
  'authorization',
];

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  /**
   * Records an auditable action. Never throws: a failed audit write must not
   * roll back the business operation, but it is logged loudly.
   */
  async record(entry: AuditEntry): Promise<void> {
    const context = RequestContext.get();
    const auth = context?.auth ?? null;

    const schoolId =
      entry.schoolId !== undefined ? entry.schoolId : (auth?.schoolId ?? null);
    const actorUserId =
      entry.actorUserId !== undefined
        ? entry.actorUserId
        : (auth?.userId ?? null);
    const membershipId =
      entry.membershipId !== undefined
        ? entry.membershipId
        : (auth?.membershipId ?? null);

    const data: Prisma.AuditLogUncheckedCreateInput = {
      schoolId,
      actorUserId,
      membershipId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      description: entry.description,
      metadata: this.sanitize(entry.metadata),
      ipAddress: context?.ip,
      userAgent: context?.userAgent?.slice(0, 255),
      requestId: context?.requestId,
    };

    try {
      // System scope so pre-tenant events (failed login) can be written with a
      // null schoolId, and so an explicit schoolId is honoured verbatim.
      await RequestContext.runAsSystem(() =>
        this.prisma.auditLog.create({ data }),
      );
    } catch (error) {
      this.logger.error(
        {
          err: error,
          action: entry.action,
          schoolId,
          entityId: entry.entityId,
        },
        'Failed to write audit log entry',
      );
    }
  }

  private sanitize(
    metadata?: Record<string, unknown>,
  ): Prisma.InputJsonValue | undefined {
    if (!metadata) return undefined;

    const clean = (value: unknown, depth = 0): unknown => {
      if (depth > 4 || value === null || typeof value !== 'object')
        return value;
      if (Array.isArray(value))
        return value.map((item) => clean(item, depth + 1));

      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, val]) => [
          key,
          REDACTED_KEYS.includes(key.toLowerCase())
            ? '[redacted]'
            : clean(val, depth + 1),
        ]),
      );
    };

    return clean(metadata) as Prisma.InputJsonValue;
  }
}
