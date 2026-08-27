import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import {
  DateRange,
  rangeContains,
  toDateOnly,
  validateRange,
} from './date-range';
import {
  CreateTermDto,
  QueryTermsDto,
  TermDto,
  UpdateTermDto,
} from './dto/term.dto';

const WITH_SESSION = {
  session: {
    // isCurrent comes along because a term may only be made current while its
    // own session is current.
    select: { name: true, startDate: true, endDate: true, isCurrent: true },
  },
} satisfies Prisma.TermInclude;

type TermRow = Prisma.TermGetPayload<{ include: typeof WITH_SESSION }>;

@Injectable()
export class TermsService {
  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  async create(dto: CreateTermDto, schoolId: string): Promise<TermDto> {
    const session = await this.getSessionOrThrow(dto.sessionId);
    const range = this.assertValidRange(dto.startDate, dto.endDate);

    this.assertWithinSession(range, session);
    await this.assertNameFree(dto.sessionId, dto.name);
    await this.assertNoOverlap(dto.sessionId, range);

    if (dto.isCurrent) {
      this.assertSessionIsCurrent(session);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      if (dto.isCurrent) {
        await tx.term.updateMany({
          where: { isCurrent: true },
          data: { isCurrent: false },
        });
      }

      return tx.term.create({
        data: {
          // Prisma's types require the tenant column on create. Supplying it is
          // safe: the guard rejects any value other than the active tenant.
          schoolId,
          sessionId: dto.sessionId,
          name: dto.name,
          startDate: range.startDate,
          endDate: range.endDate,
          isCurrent: dto.isCurrent ?? false,
        },
        include: WITH_SESSION,
      });
    });

    return this.toDto(created);
  }

  async list(query: QueryTermsDto): Promise<PaginatedDto<TermDto>> {
    const where: Prisma.TermWhereInput = {
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.isCurrent !== undefined ? { isCurrent: query.isCurrent } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.term.findMany({
        where,
        // The TermName enum is declared FIRST, SECOND, THIRD, so sorting by
        // name yields calendar order rather than alphabetical order.
        orderBy: { [query.sortBy]: query.sortOrder },
        skip: query.skip,
        take: query.limit,
        include: WITH_SESSION,
      }),
      this.prisma.term.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toDto(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(id: string): Promise<TermDto> {
    return this.toDto(await this.getOrThrow(id));
  }

  /** The term the school is currently running — drives fees and results later. */
  async findCurrent(): Promise<TermDto> {
    const current = await this.prisma.term.findFirst({
      where: { isCurrent: true },
      include: WITH_SESSION,
    });

    if (!current) {
      throw AppException.notFound('No current term');
    }

    return this.toDto(current);
  }

  async update(id: string, dto: UpdateTermDto): Promise<TermDto> {
    const existing = await this.getOrThrow(id);

    const name = dto.name ?? existing.name;
    const range = this.assertValidRange(
      dto.startDate ?? existing.startDate,
      dto.endDate ?? existing.endDate,
    );

    this.assertWithinSession(range, existing.session);

    if (dto.name && dto.name !== existing.name) {
      await this.assertNameFree(existing.sessionId, dto.name);
    }
    if (dto.startDate || dto.endDate) {
      await this.assertNoOverlap(existing.sessionId, range, id);
    }

    const updated = await this.prisma.term.update({
      where: { id },
      data: { name, startDate: range.startDate, endDate: range.endDate },
      include: WITH_SESSION,
    });

    return this.toDto(updated);
  }

  /** Exactly one term is current per school; this moves the marker. */
  async setCurrent(id: string): Promise<TermDto> {
    const existing = await this.getOrThrow(id);
    this.assertSessionIsCurrent(existing.session);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.term.updateMany({
        where: { isCurrent: true },
        data: { isCurrent: false },
      });

      return tx.term.update({
        where: { id },
        data: { isCurrent: true },
        include: WITH_SESSION,
      });
    });

    return this.toDto(updated);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.getOrThrow(id);

    if (existing.isCurrent) {
      throw AppException.conflict(
        'The current term cannot be deleted. Make another term current first.',
      );
    }

    await this.prisma.term.delete({ where: { id } });
  }

  private async getOrThrow(id: string): Promise<TermRow> {
    const found = await this.prisma.term.findUnique({
      where: { id },
      include: WITH_SESSION,
    });

    if (!found) {
      throw AppException.notFound('Term');
    }

    return found;
  }

  /** Cross-tenant ids resolve to nothing here: the guard scopes the lookup. */
  private async getSessionOrThrow(sessionId: string) {
    const session = await this.prisma.academicSession.findUnique({
      where: { id: sessionId },
      select: {
        name: true,
        startDate: true,
        endDate: true,
        isCurrent: true,
      },
    });

    if (!session) {
      throw AppException.notFound('Academic session');
    }

    return session;
  }

  private assertValidRange(start: Date, end: Date): DateRange {
    const range = { startDate: toDateOnly(start), endDate: toDateOnly(end) };
    const error = validateRange(range);
    if (error) {
      throw AppException.badRequest(error, ErrorCode.VALIDATION_ERROR);
    }
    return range;
  }

  /** A term outside its session's dates would break every date-driven report. */
  private assertWithinSession(range: DateRange, session: DateRange): void {
    if (!rangeContains(session, range)) {
      throw AppException.badRequest(
        'Term dates must fall within the session dates',
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  /**
   * The current term and current session must agree, or fee and result queries
   * that read both would disagree with each other.
   */
  private assertSessionIsCurrent(session: { isCurrent: boolean }): void {
    if (!session.isCurrent) {
      throw AppException.conflict(
        'Only a term of the current session can be made current. Make its session current first.',
      );
    }
  }

  private async assertNameFree(
    sessionId: string,
    name: TermRow['name'],
  ): Promise<void> {
    const clash = await this.prisma.term.findFirst({
      where: { sessionId, name },
      select: { id: true },
    });

    if (clash) {
      throw AppException.duplicate(`This session already has a ${name} term`);
    }
  }

  private async assertNoOverlap(
    sessionId: string,
    range: DateRange,
    excludeId?: string,
  ): Promise<void> {
    const overlapping = await this.prisma.term.findFirst({
      where: {
        sessionId,
        ...(excludeId ? { id: { not: excludeId } } : {}),
        startDate: { lte: range.endDate },
        endDate: { gte: range.startDate },
      },
      select: { name: true },
    });

    if (overlapping) {
      throw AppException.conflict(
        `These dates overlap the ${overlapping.name} term`,
      );
    }
  }

  private toDto(row: TermRow): TermDto {
    return {
      id: row.id,
      sessionId: row.sessionId,
      sessionName: row.session.name,
      name: row.name,
      startDate: row.startDate,
      endDate: row.endDate,
      isCurrent: row.isCurrent,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
