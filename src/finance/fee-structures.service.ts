import { Injectable } from '@nestjs/common';
import { FeeStructureStatus, Prisma } from '@prisma/client';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma, TxClient } from '../database/prisma.service';
import {
  CreateFeeStructureDto,
  FeeStructureDto,
  FeeStructureItemInputDto,
  QueryFeeStructuresDto,
  UpdateFeeStructureDto,
} from './dto/fee-structure.dto';
import { sum, toAmount } from './fee-math';

const WITH_DETAIL = {
  session: { select: { name: true } },
  term: { select: { name: true } },
  class: { select: { name: true } },
  items: {
    include: { category: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  },
  _count: { select: { studentFees: true } },
} satisfies Prisma.FeeStructureInclude;

type StructureRow = Prisma.FeeStructureGetPayload<{
  include: typeof WITH_DETAIL;
}>;

@Injectable()
export class FeeStructuresService {
  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  async create(
    dto: CreateFeeStructureDto,
    schoolId: string,
  ): Promise<FeeStructureDto> {
    await this.assertSessionExists(dto.sessionId);
    if (dto.termId) await this.assertTermInSession(dto.termId, dto.sessionId);
    if (dto.classId) await this.assertClassExists(dto.classId);
    await this.assertNameFree(dto.sessionId, dto.name);
    await this.assertCategoriesUsable(dto.items);

    const created = await this.prisma.$transaction(async (tx) => {
      const structure = await tx.feeStructure.create({
        data: {
          // Prisma's types require the tenant column on create. Supplying it is
          // safe: the guard rejects any value other than the active tenant.
          schoolId,
          sessionId: dto.sessionId,
          termId: dto.termId ?? null,
          classId: dto.classId ?? null,
          name: dto.name,
          description: dto.description ?? null,
          dueDate: dto.dueDate ?? null,
          totalAmount: this.compulsoryTotal(dto.items),
        },
      });

      await this.writeItems(tx, structure.id, schoolId, dto.items);
      return structure.id;
    });

    return this.findOne(created);
  }

  async list(
    query: QueryFeeStructuresDto,
  ): Promise<PaginatedDto<FeeStructureDto>> {
    const where: Prisma.FeeStructureWhereInput = {
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.termId ? { termId: query.termId } : {}),
      ...(query.classId ? { classId: query.classId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? { name: { contains: query.search, mode: 'insensitive' } }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.feeStructure.findMany({
        where,
        orderBy: { [query.sortBy]: query.sortOrder },
        skip: query.skip,
        take: query.limit,
        include: WITH_DETAIL,
      }),
      this.prisma.feeStructure.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toDto(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(id: string): Promise<FeeStructureDto> {
    return this.toDto(await this.getOrThrow(id));
  }

  async update(
    id: string,
    dto: UpdateFeeStructureDto,
  ): Promise<FeeStructureDto> {
    const existing = await this.getOrThrow(id);

    if (dto.name && dto.name !== existing.name) {
      await this.assertNameFree(existing.sessionId, dto.name);
    }

    // Amounts are frozen once invoices exist: an issued bill is a promise, and
    // editing the structure behind it would silently restate what was owed.
    if (dto.items) {
      this.assertNoInvoices(
        existing,
        'Fee amounts cannot change once invoices have been issued. Archive this structure and create a new one.',
      );
      await this.assertCategoriesUsable(dto.items);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.feeStructure.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description,
          dueDate: dto.dueDate,
          ...(dto.items
            ? { totalAmount: this.compulsoryTotal(dto.items) }
            : {}),
        },
      });

      if (dto.items) {
        await tx.feeStructureItem.deleteMany({ where: { structureId: id } });
        await this.writeItems(tx, id, existing.schoolId, dto.items);
      }
    });

    return this.findOne(id);
  }

  /** Publishing is what makes a structure assignable to students. */
  async publish(id: string): Promise<FeeStructureDto> {
    const existing = await this.getOrThrow(id);

    if (existing.status === FeeStructureStatus.PUBLISHED) {
      throw AppException.conflict('This fee structure is already published');
    }
    if (existing.status === FeeStructureStatus.ARCHIVED) {
      throw AppException.conflict(
        'An archived fee structure cannot be published again',
      );
    }
    if (existing.items.length === 0) {
      throw AppException.conflict(
        'A fee structure needs at least one item before it can be published',
      );
    }

    await this.prisma.feeStructure.update({
      where: { id },
      data: { status: FeeStructureStatus.PUBLISHED },
    });

    return this.findOne(id);
  }

  /** Archiving retires a structure without touching the invoices it produced. */
  async archive(id: string): Promise<FeeStructureDto> {
    const existing = await this.getOrThrow(id);

    if (existing.status === FeeStructureStatus.ARCHIVED) {
      throw AppException.conflict('This fee structure is already archived');
    }

    await this.prisma.feeStructure.update({
      where: { id },
      data: { status: FeeStructureStatus.ARCHIVED },
    });

    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.getOrThrow(id);

    this.assertNoInvoices(
      existing,
      'This fee structure has issued invoices and cannot be deleted. Archive it instead.',
    );

    await this.prisma.feeStructure.delete({ where: { id } });
  }

  /** Assignment needs the structure, its items and its scope. */
  async getPublishedOrThrow(id: string): Promise<StructureRow> {
    const structure = await this.getOrThrow(id);

    if (structure.status !== FeeStructureStatus.PUBLISHED) {
      throw AppException.conflict(
        `Only a PUBLISHED fee structure can be assigned; this one is ${structure.status}`,
      );
    }

    return structure;
  }

  private async getOrThrow(id: string): Promise<StructureRow> {
    const found = await this.prisma.feeStructure.findUnique({
      where: { id },
      include: WITH_DETAIL,
    });

    if (!found) {
      throw AppException.notFound('Fee structure');
    }

    return found;
  }

  private assertNoInvoices(structure: StructureRow, message: string): void {
    if (structure._count.studentFees > 0) {
      throw AppException.conflict(message);
    }
  }

  /** Optional items are quoted, not charged, so they stay out of the total. */
  private compulsoryTotal(items: FeeStructureItemInputDto[]): Prisma.Decimal {
    return sum(
      items
        .filter((item) => !item.isOptional)
        .map((item) => new Prisma.Decimal(item.amount)),
    );
  }

  private async writeItems(
    tx: TxClient,
    structureId: string,
    schoolId: string,
    items: FeeStructureItemInputDto[],
  ): Promise<void> {
    await tx.feeStructureItem.createMany({
      data: items.map((item) => ({
        schoolId,
        structureId,
        categoryId: item.categoryId,
        amount: new Prisma.Decimal(item.amount),
        isOptional: item.isOptional ?? false,
      })),
    });
  }

  private async assertCategoriesUsable(
    items: FeeStructureItemInputDto[],
  ): Promise<void> {
    const ids = items.map((item) => item.categoryId);
    if (new Set(ids).size !== ids.length) {
      throw AppException.badRequest(
        'A fee category can only appear once in a structure',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const found = await this.prisma.feeCategory.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, isActive: true },
    });

    if (found.length !== new Set(ids).size) {
      throw AppException.notFound('Fee category');
    }

    const retired = found.filter((category) => !category.isActive);
    if (retired.length > 0) {
      throw AppException.conflict(
        `Retired fee categories cannot be charged: ${retired
          .map((category) => category.name)
          .join(', ')}`,
      );
    }
  }

  /** Cross-tenant ids resolve to nothing: the guard scopes these lookups. */
  private async assertSessionExists(sessionId: string): Promise<void> {
    const found = await this.prisma.academicSession.findUnique({
      where: { id: sessionId },
      select: { id: true },
    });
    if (!found) throw AppException.notFound('Academic session');
  }

  private async assertTermInSession(
    termId: string,
    sessionId: string,
  ): Promise<void> {
    const term = await this.prisma.term.findUnique({
      where: { id: termId },
      select: { sessionId: true },
    });

    if (!term) throw AppException.notFound('Term');
    if (term.sessionId !== sessionId) {
      throw AppException.badRequest(
        'The term does not belong to that session',
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  private async assertClassExists(classId: string): Promise<void> {
    const found = await this.prisma.class.findUnique({
      where: { id: classId },
      select: { id: true },
    });
    if (!found) throw AppException.notFound('Class');
  }

  private async assertNameFree(sessionId: string, name: string): Promise<void> {
    const clash = await this.prisma.feeStructure.findFirst({
      where: { sessionId, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });

    if (clash) {
      throw AppException.duplicate(
        `A fee structure named "${name}" already exists in this session`,
      );
    }
  }

  private toDto(row: StructureRow): FeeStructureDto {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      sessionId: row.sessionId,
      sessionName: row.session.name,
      termId: row.termId,
      termName: row.term?.name ?? null,
      classId: row.classId,
      className: row.class?.name ?? null,
      status: row.status,
      dueDate: row.dueDate,
      totalAmount: toAmount(row.totalAmount),
      items: row.items.map((item) => ({
        id: item.id,
        categoryId: item.categoryId,
        categoryName: item.category.name,
        amount: toAmount(item.amount),
        isOptional: item.isOptional,
      })),
      invoiceCount: row._count.studentFees,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
