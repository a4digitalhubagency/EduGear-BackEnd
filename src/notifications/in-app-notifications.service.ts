import { Injectable, Logger } from '@nestjs/common';
import { MembershipStatus, NotificationType, Prisma } from '@prisma/client';
import { RequestContext } from '../common/context/request-context';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { NotificationDto, QueryNotificationsDto } from './dto/notification.dto';

export interface NotificationDraft {
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, string | number | null>;
}

/**
 * The parent portal's inbox.
 *
 * Messages go to the parents of a student who have an active portal login —
 * resolved at send time from the guardian links, so a parent linked tomorrow
 * does not receive yesterday's news and a revoked parent receives nothing.
 *
 * Like audit logging, a notification is a side effect: failing to write one is
 * logged and swallowed, never allowed to roll back the result being published
 * or the payment being verified.
 */
@Injectable()
export class InAppNotificationsService {
  private readonly logger = new Logger(InAppNotificationsService.name);

  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  /** One message per student to each of that student's portal parents. */
  async notifyParentsOf(
    students: { studentId: string; draft: NotificationDraft }[],
  ): Promise<number> {
    try {
      const schoolId = RequestContext.getTenantId();
      if (!schoolId || students.length === 0) return 0;

      const links = await this.prisma.studentGuardian.findMany({
        where: {
          studentId: { in: students.map((s) => s.studentId) },
          guardian: { userId: { not: null } },
        },
        select: { studentId: true, guardian: { select: { userId: true } } },
      });

      const userIds = [...new Set(links.map((l) => l.guardian.userId!))];
      const active = await this.prisma.membership.findMany({
        where: { userId: { in: userIds }, status: MembershipStatus.ACTIVE },
        select: { userId: true },
      });
      const reachable = new Set(active.map((m) => m.userId));

      const data: Prisma.NotificationCreateManyInput[] = [];
      for (const { studentId, draft } of students) {
        for (const link of links.filter((l) => l.studentId === studentId)) {
          const userId = link.guardian.userId!;
          if (!reachable.has(userId)) continue;
          data.push({
            schoolId,
            userId,
            type: draft.type,
            title: draft.title,
            body: draft.body,
            data: { studentId, ...draft.data },
          });
        }
      }

      if (data.length > 0) await this.prisma.notification.createMany({ data });
      return data.length;
    } catch (error) {
      this.logger.error(
        `Failed to write notifications: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  async list(
    query: QueryNotificationsDto,
  ): Promise<PaginatedDto<NotificationDto> & { unread: number }> {
    const userId = this.currentUser();
    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(query.unreadOnly ? { readAt: null } : {}),
    };

    const [rows, total, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);

    return {
      ...paginate(
        rows.map((row) => this.toDto(row)),
        total,
        query.page,
        query.limit,
      ),
      unread,
    };
  }

  async markRead(id: string): Promise<NotificationDto> {
    const userId = this.currentUser();
    // Scoped to the caller: another parent's notification id matches nothing.
    await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    const row = await this.prisma.notification.findFirst({
      where: { id, userId },
    });
    if (!row) throw AppException.notFound('Notification');
    return this.toDto(row);
  }

  async markAllRead(): Promise<{ updated: number }> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId: this.currentUser(), readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
  }

  private currentUser(): string {
    const auth = RequestContext.getAuth();
    if (!auth) throw AppException.unauthorized();
    return auth.userId;
  }

  private toDto(row: {
    id: string;
    type: NotificationType;
    title: string;
    body: string;
    data: Prisma.JsonValue;
    readAt: Date | null;
    createdAt: Date;
  }): NotificationDto {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      data: (row.data ?? {}) as Record<string, unknown>,
      read: row.readAt !== null,
      readAt: row.readAt,
      createdAt: row.createdAt,
    };
  }
}
