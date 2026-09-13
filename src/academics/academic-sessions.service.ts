import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { validateSessionName } from './academic-session-rules';
import { DateRange, toDateOnly, validateRange } from './date-range';
import {
  AcademicSessionDto,
  CreateAcademicSessionDto,
  QueryAcademicSessionsDto,
  UpdateAcademicSessionDto,
} from './dto/academic-session.dto';

/** Shape returned by every query here, so `toDto` has what it needs. */
const WITH_TERM_COUNT = {
  _count: { select: { terms: true } },
} satisfies Prisma.AcademicSessionInclude;

type SessionRow = Prisma.AcademicSessionGetPayload<{
  include: typeof WITH_TERM_COUNT;
}>;

@Injectable()
export class AcademicSessionsService {
  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  async create(
    dto: CreateAcademicSessionDto,
    schoolId: string,
  ): Promise<AcademicSessionDto> {
    const range = this.assertValid(dto.name, dto.startDate, dto.endDate);
    await this.assertNameFree(dto.name);
    await this.assertNoOverlap(range);

    // Setting a new session current must clear the previous one atomically,
    // or a failure halfway leaves the school with two current sessions.
    const created = await this.prisma.$transaction(async (tx) => {
      if (dto.isCurrent) {
        await tx.academicSession.updateMany({
          where: { isCurrent: true },
          data: { isCurrent: false },
        });
      }

      return tx.academicSession.create({
        data: {
          // Prisma's types require the tenant column on create. Supplying it is
          // safe: the guard rejects any value other than the active tenant.
          schoolId,
          name: dto.name,
          startDate: range.startDate,
          endDate: range.endDate,
          isCurrent: dto.isCurrent ?? false,
        },
        include: WITH_TERM_COUNT,
      });
    });

    return this.toDto(created);
  }

  async list(
    query: QueryAcademicSessionsDto,
  ): Promise<PaginatedDto<AcademicSessionDto>> {
    const where: Prisma.AcademicSessionWhereInput = {
      ...(query.isCurrent !== undefined ? { isCurrent: query.isCurrent } : {}),
      ...(query.search
        ? { name: { contains: query.search, mode: 'insensitive' } }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.academicSession.findMany({
        where,
        orderBy: { [query.sortBy]: query.sortOrder },
        skip: query.skip,
        take: query.limit,
        include: WITH_TERM_COUNT,
      }),
      this.prisma.academicSession.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toDto(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(id: string): Promise<AcademicSessionDto> {
    return this.toDto(await this.getOrThrow(id));
  }

  /** The session the school is currently running. */
  async findCurrent(): Promise<AcademicSessionDto> {
    const current = await this.prisma.academicSession.findFirst({
      where: { isCurrent: true },
      include: WITH_TERM_COUNT,
    });

    if (!current) {
      throw AppException.notFound('No current academic session');
    }

    return this.toDto(current);
  }

  async update(
    id: string,
    dto: UpdateAcademicSessionDto,
  ): Promise<AcademicSessionDto> {
    const existing = await this.getOrThrow(id);

    const name = dto.name ?? existing.name;
    const startDate = dto.startDate ?? existing.startDate;
    const endDate = dto.endDate ?? existing.endDate;
    const range = this.assertValid(name, startDate, endDate);

    if (dto.name && dto.name !== existing.name) {
      await this.assertNameFree(dto.name);
    }
    if (dto.startDate || dto.endDate) {
      await this.assertNoOverlap(range, id);
    }

    const updated = await this.prisma.academicSession.update({
      where: { id },
      data: { name, startDate: range.startDate, endDate: range.endDate },
      include: WITH_TERM_COUNT,
    });

    return this.toDto(updated);
  }

  /** Exactly one session is current per school; this moves the marker. */
  async setCurrent(id: string): Promise<AcademicSessionDto> {
    await this.getOrThrow(id);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.academicSession.updateMany({
        where: { isCurrent: true },
        data: { isCurrent: false },
      });

      return tx.academicSession.update({
        where: { id },
        data: { isCurrent: true },
        include: WITH_TERM_COUNT,
      });
    });

    return this.toDto(updated);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.getOrThrow(id);

    if (existing.isCurrent) {
      throw AppException.conflict(
        'The current session cannot be deleted. Make another session current first.',
      );
    }

    // Terms cascade at the database level, so refuse rather than silently
    // deleting a session's whole term structure.
    if (existing._count.terms > 0) {
      throw AppException.conflict(
        `This session has ${existing._count.terms} term(s). Delete them first.`,
      );
    }

    // Fee structures cascade from the session too, and invoices restrict them.
    const structures = await this.prisma.feeStructure.count({
      where: { sessionId: id },
    });
    if (structures > 0) {
      throw AppException.conflict(
        `This session has ${structures} fee structure(s) built on it. Archive or delete them first.`,
      );
    }

    await this.prisma.academicSession.delete({ where: { id } });
  }

  private async getOrThrow(id: string): Promise<SessionRow> {
    const found = await this.prisma.academicSession.findUnique({
      where: { id },
      include: WITH_TERM_COUNT,
    });

    if (!found) {
      throw AppException.notFound('Academic session');
    }

    return found;
  }

  private assertValid(name: string, start: Date, end: Date): DateRange {
    const nameError = validateSessionName(name);
    if (nameError) {
      throw AppException.badRequest(nameError, ErrorCode.VALIDATION_ERROR);
    }

    const range = { startDate: toDateOnly(start), endDate: toDateOnly(end) };
    const rangeError = validateRange(range);
    if (rangeError) {
      throw AppException.badRequest(rangeError, ErrorCode.VALIDATION_ERROR);
    }

    return range;
  }

  private async assertNameFree(name: string): Promise<void> {
    const clash = await this.prisma.academicSession.findFirst({
      where: { name },
      select: { id: true },
    });

    if (clash) {
      throw AppException.duplicate(`Session "${name}" already exists`);
    }
  }

  /** A school cannot be running two sessions on the same day. */
  private async assertNoOverlap(
    range: DateRange,
    excludeId?: string,
  ): Promise<void> {
    const overlapping = await this.prisma.academicSession.findFirst({
      where: {
        ...(excludeId ? { id: { not: excludeId } } : {}),
        startDate: { lte: range.endDate },
        endDate: { gte: range.startDate },
      },
      select: { id: true, name: true },
    });

    if (overlapping) {
      throw AppException.conflict(
        `These dates overlap session "${overlapping.name}"`,
      );
    }
  }

  private toDto(row: SessionRow): AcademicSessionDto {
    return {
      id: row.id,
      name: row.name,
      startDate: row.startDate,
      endDate: row.endDate,
      isCurrent: row.isCurrent,
      termCount: row._count.terms,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
