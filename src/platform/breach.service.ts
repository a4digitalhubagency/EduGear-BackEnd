import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { RequestContext } from '../common/context/request-context';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import {
  ATTENTION_WARNING_HOURS,
  COMMISSION_NOTIFICATION_WINDOW_HOURS,
  commissionDeadline,
  hoursUntilDeadline,
  needsAttention,
  notificationState,
} from './breach-clock';
import {
  BreachDto,
  QueryBreachesDto,
  RecordBreachDto,
  UpdateBreachDto,
} from './dto/breach.dto';

type BreachRow = Prisma.BreachRecordGetPayload<Record<string, never>>;

/** Retries cover the window between reading the last reference and writing it. */
const REFERENCE_ATTEMPTS = 5;

/**
 * The breach register that **section 40(8)** requires a controller and a
 * processor to keep: "a record of all personal data breaches, comprising the
 * facts relating to the personal data breach, its effects and the remedial
 * action taken in a manner that enables the Commission to verify compliance".
 *
 * It is A4's register rather than a school's, which is why it lives on the
 * platform surface and why `BreachRecord` carries no `schoolId`. One incident
 * can touch several tenants or none at all, and the operator recording it
 * belongs to no school.
 *
 * **Nothing here is ever deleted.** A register you can edit your way out of is
 * not evidence. Entries are corrected by update — every change leaves an audit
 * row — and closed by status, never removed.
 */
@Injectable()
export class BreachService {
  private readonly logger = new Logger(BreachService.name);

  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly audit: AuditService,
  ) {}

  /**
   * Opens a register entry.
   *
   * Deliberately cheap to do. The 72-hour clock is already running by the time
   * anyone thinks to record something, so this asks only for what Article
   * 33(5) demands up front and lets the rest arrive by update — which is
   * exactly what section 40(9) contemplates when it allows information "in
   * phases without undue delay".
   */
  async record(dto: RecordBreachDto, adminId?: string): Promise<BreachDto> {
    const discoveredAt = new Date(dto.discoveredAt);

    return RequestContext.runAsSystem(async () => {
      for (let attempt = 1; attempt <= REFERENCE_ATTEMPTS; attempt += 1) {
        try {
          const created = await this.prisma.breachRecord.create({
            data: {
              reference: await this.nextReference(
                discoveredAt.getUTCFullYear(),
              ),
              discoveredAt,
              occurredFrom: dto.occurredFrom
                ? new Date(dto.occurredFrom)
                : null,
              occurredTo: dto.occurredTo ? new Date(dto.occurredTo) : null,
              description: dto.description,
              dataCategories: dto.dataCategories,
              riskAssessment: dto.riskAssessment,
              highRisk: dto.highRisk ?? false,
              affectedSubjects: dto.affectedSubjects ?? null,
              affectedSchoolIds: dto.affectedSchoolIds ?? [],
              containment: dto.containment ?? null,
              contactName: dto.contactName,
              contactEmail: dto.contactEmail,
              recordedByAdminId: adminId ?? null,
            },
          });

          // Logged at warn: a breach record being created is not routine, and
          // the one place everybody already watches is the application log.
          this.logger.warn(
            `Breach ${created.reference} recorded; Commission deadline ${commissionDeadline(discoveredAt).toISOString()}`,
          );

          await this.audit.record({
            action: AUDIT_ACTIONS.PLATFORM_BREACH_RECORDED,
            entityType: 'BreachRecord',
            entityId: created.id,
            description: `Breach ${created.reference} recorded`,
            metadata: {
              reference: created.reference,
              highRisk: created.highRisk,
              affectedSchools: created.affectedSchoolIds.length,
            },
          });

          return this.toDto(created);
        } catch (error) {
          // The unique index is the real guard; the read above only guesses.
          if (this.isDuplicateReference(error)) continue;
          throw error;
        }
      }

      throw AppException.conflict(
        'Could not allocate a breach reference; please retry',
      );
    });
  }

  async list(query: QueryBreachesDto): Promise<PaginatedDto<BreachDto>> {
    const now = new Date();
    const where: Prisma.BreachRecordWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.needsAttention ? this.attentionFilter(now) : {}),
    };

    return RequestContext.runAsSystem(async () => {
      const [rows, total] = await Promise.all([
        this.prisma.breachRecord.findMany({
          where,
          // Most recently discovered first: the ones whose clock is running.
          // `id` breaks ties so a page boundary cannot repeat or skip a row.
          orderBy: [{ discoveredAt: 'desc' }, { id: 'desc' }],
          skip: query.skip,
          take: query.limit,
        }),
        this.prisma.breachRecord.count({ where }),
      ]);

      return paginate(
        rows.map((row) => this.toDto(row, now)),
        total,
        query.page,
        query.limit,
      );
    });
  }

  async get(id: string): Promise<BreachDto> {
    return RequestContext.runAsSystem(async () => {
      const row = await this.prisma.breachRecord.findUnique({ where: { id } });
      if (!row) throw AppException.notFound('Breach record');
      return this.toDto(row);
    });
  }

  /**
   * Amends an entry as the investigation proceeds.
   *
   * There is no delete. A register that can be emptied proves nothing, and
   * s.40(8) asks for a record that lets the Commission *verify* compliance —
   * which means the embarrassing entries have to survive too.
   */
  async update(id: string, dto: UpdateBreachDto): Promise<BreachDto> {
    return RequestContext.runAsSystem(async () => {
      const existing = await this.prisma.breachRecord.findUnique({
        where: { id },
      });
      if (!existing) throw AppException.notFound('Breach record');

      const data: Prisma.BreachRecordUpdateInput = {
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.dataCategories !== undefined
          ? { dataCategories: dto.dataCategories }
          : {}),
        ...(dto.riskAssessment !== undefined
          ? { riskAssessment: dto.riskAssessment }
          : {}),
        ...(dto.highRisk !== undefined ? { highRisk: dto.highRisk } : {}),
        ...(dto.affectedSubjects !== undefined
          ? { affectedSubjects: dto.affectedSubjects }
          : {}),
        ...(dto.affectedSchoolIds !== undefined
          ? { affectedSchoolIds: dto.affectedSchoolIds }
          : {}),
        ...(dto.containment !== undefined
          ? { containment: dto.containment }
          : {}),
        ...(dto.subjectNotification !== undefined
          ? { subjectNotification: dto.subjectNotification }
          : {}),
        ...(dto.subjectsNotifiedAt !== undefined
          ? { subjectsNotifiedAt: new Date(dto.subjectsNotifiedAt) }
          : {}),
        ...(dto.commissionNotifiedAt !== undefined
          ? { commissionNotifiedAt: new Date(dto.commissionNotifiedAt) }
          : {}),
        ...(dto.notificationNotRequiredReason !== undefined
          ? {
              notificationNotRequiredReason: dto.notificationNotRequiredReason,
            }
          : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.contactName !== undefined
          ? { contactName: dto.contactName }
          : {}),
        ...(dto.contactEmail !== undefined
          ? { contactEmail: dto.contactEmail }
          : {}),
      };

      const updated = await this.prisma.breachRecord.update({
        where: { id },
        data,
      });

      // Named separately because "we told the Commission" is the single fact
      // this whole register exists to be able to prove.
      if (!existing.commissionNotifiedAt && updated.commissionNotifiedAt) {
        await this.audit.record({
          action: AUDIT_ACTIONS.PLATFORM_BREACH_COMMISSION_NOTIFIED,
          entityType: 'BreachRecord',
          entityId: updated.id,
          description: `Commission notified of breach ${updated.reference}`,
          metadata: {
            reference: updated.reference,
            notificationState: notificationState(updated, new Date()),
          },
        });
      }

      await this.audit.record({
        action: AUDIT_ACTIONS.PLATFORM_BREACH_UPDATED,
        entityType: 'BreachRecord',
        entityId: updated.id,
        description: `Breach ${updated.reference} updated`,
        // Field names only. The narrative fields can hold details of an
        // incident, and copying them into a second table doubles the exposure.
        metadata: { fields: Object.keys(data) },
      });

      return this.toDto(updated);
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * `BR-<year>-<4 digits>`, continuing the year's run.
   *
   * Reads the highest issued and adds one, like admission and receipt numbers.
   * The read is a guess; the unique index decides, and `record` retries on the
   * collision.
   */
  private async nextReference(year: number): Promise<string> {
    const latest = await this.prisma.breachRecord.findFirst({
      where: { reference: { startsWith: `BR-${year}-` } },
      orderBy: { reference: 'desc' },
      select: { reference: true },
    });

    const sequence = latest
      ? Number(latest.reference.slice(`BR-${year}-`.length)) + 1
      : 1;

    return `BR-${year}-${String(sequence).padStart(4, '0')}`;
  }

  /**
   * `needsAttention`, expressed as a database filter.
   *
   * It has to be a filter rather than a `.filter()` over the page, or the
   * total would count rows the page then dropped — a register that says
   * "3 breaches need attention" and shows one is worse than no filter at all.
   *
   * The algebra: attention is due once the deadline is within
   * `ATTENTION_WARNING_HOURS`, i.e. `discoveredAt + 72h - now <= 24h`, i.e.
   * `discoveredAt <= now - 48h`. Both constants come from the clock module so
   * the two definitions cannot drift.
   *
   * The blank-reason case is exact here because the DTO trims the field and
   * requires 20 characters, so a whitespace-only reason can never be stored.
   */
  private attentionFilter(now: Date): Prisma.BreachRecordWhereInput {
    const graceHours =
      COMMISSION_NOTIFICATION_WINDOW_HOURS - ATTENTION_WARNING_HOURS;
    const cutoff = new Date(now.getTime() - graceHours * 60 * 60 * 1000);

    return {
      commissionNotifiedAt: null,
      discoveredAt: { lte: cutoff },
      OR: [
        { notificationNotRequiredReason: null },
        { notificationNotRequiredReason: '' },
      ],
    };
  }

  private isDuplicateReference(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private toDto(row: BreachRow, now = new Date()): BreachDto {
    return {
      id: row.id,
      reference: row.reference,
      discoveredAt: row.discoveredAt,
      occurredFrom: row.occurredFrom,
      occurredTo: row.occurredTo,
      description: row.description,
      dataCategories: row.dataCategories,
      riskAssessment: row.riskAssessment,
      highRisk: row.highRisk,
      affectedSubjects: row.affectedSubjects,
      affectedSchoolIds: row.affectedSchoolIds,
      containment: row.containment,
      subjectNotification: row.subjectNotification,
      subjectsNotifiedAt: row.subjectsNotifiedAt,
      commissionNotifiedAt: row.commissionNotifiedAt,
      notificationNotRequiredReason: row.notificationNotRequiredReason,
      contactName: row.contactName,
      contactEmail: row.contactEmail,
      status: row.status,
      commissionDeadline: commissionDeadline(row.discoveredAt),
      notificationState: notificationState(row, now),
      hoursUntilDeadline: hoursUntilDeadline(row.discoveredAt, now),
      needsAttention: needsAttention(row, now),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
