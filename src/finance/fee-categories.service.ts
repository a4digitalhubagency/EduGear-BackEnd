import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import {
  CreateFeeCategoryDto,
  FeeCategoryDto,
  QueryFeeCategoriesDto,
  UpdateFeeCategoryDto,
} from './dto/fee-category.dto';

const WITH_USAGE = {
  _count: { select: { items: true } },
} satisfies Prisma.FeeCategoryInclude;

type CategoryRow = Prisma.FeeCategoryGetPayload<{ include: typeof WITH_USAGE }>;

@Injectable()
export class FeeCategoriesService {
  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  async create(
    dto: CreateFeeCategoryDto,
    schoolId: string,
  ): Promise<FeeCategoryDto> {
    await this.assertNameFree(dto.name);

    const created = await this.prisma.feeCategory.create({
      data: {
        // Prisma's types require the tenant column on create. Supplying it is
        // safe: the guard rejects any value other than the active tenant.
        schoolId,
        name: dto.name,
        description: dto.description ?? null,
      },
      include: WITH_USAGE,
    });

    return this.toDto(created);
  }

  async list(
    query: QueryFeeCategoriesDto,
  ): Promise<PaginatedDto<FeeCategoryDto>> {
    const where: Prisma.FeeCategoryWhereInput = {
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search
        ? { name: { contains: query.search, mode: 'insensitive' } }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.feeCategory.findMany({
        where,
        orderBy: { [query.sortBy]: query.sortOrder },
        skip: query.skip,
        take: query.limit,
        include: WITH_USAGE,
      }),
      this.prisma.feeCategory.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toDto(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(id: string): Promise<FeeCategoryDto> {
    return this.toDto(await this.getOrThrow(id));
  }

  async update(id: string, dto: UpdateFeeCategoryDto): Promise<FeeCategoryDto> {
    const existing = await this.getOrThrow(id);

    if (dto.name && dto.name !== existing.name) {
      await this.assertNameFree(dto.name);
    }

    const updated = await this.prisma.feeCategory.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        isActive: dto.isActive,
      },
      include: WITH_USAGE,
    });

    return this.toDto(updated);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.getOrThrow(id);

    // A category in use is referenced by issued bills. Deactivate it instead:
    // the name has to stay readable on invoices already sent to parents.
    if (existing._count.items > 0) {
      throw AppException.conflict(
        `"${existing.name}" is used by ${existing._count.items} fee structure item(s). Deactivate it instead of deleting.`,
      );
    }

    await this.prisma.feeCategory.delete({ where: { id } });
  }

  /** Used by fee structures before adding an item. */
  async assertUsable(id: string): Promise<CategoryRow> {
    const category = await this.getOrThrow(id);

    if (!category.isActive) {
      throw AppException.conflict(
        `"${category.name}" is retired and cannot be added to a fee structure`,
      );
    }

    return category;
  }

  private async getOrThrow(id: string): Promise<CategoryRow> {
    const found = await this.prisma.feeCategory.findUnique({
      where: { id },
      include: WITH_USAGE,
    });

    if (!found) {
      throw AppException.notFound('Fee category');
    }

    return found;
  }

  private async assertNameFree(name: string): Promise<void> {
    const clash = await this.prisma.feeCategory.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });

    if (clash) {
      throw AppException.duplicate(
        `A fee category named "${name}" already exists`,
      );
    }
  }

  private toDto(row: CategoryRow): FeeCategoryDto {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      isActive: row.isActive,
      usageCount: row._count.items,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
