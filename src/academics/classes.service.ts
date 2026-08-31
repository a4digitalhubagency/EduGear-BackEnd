import { Injectable } from '@nestjs/common';
import { Prisma, StudentStatus } from '@prisma/client';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import {
  ClassDto,
  CreateClassDto,
  QueryClassesDto,
  UpdateClassDto,
} from './dto/class.dto';

const WITH_ARM_COUNT = {
  _count: { select: { arms: true } },
} satisfies Prisma.ClassInclude;

type ClassRow = Prisma.ClassGetPayload<{ include: typeof WITH_ARM_COUNT }>;

@Injectable()
export class ClassesService {
  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  async create(dto: CreateClassDto, schoolId: string): Promise<ClassDto> {
    await this.assertNameFree(dto.name);
    await this.assertLevelFree(dto.level);

    const created = await this.prisma.class.create({
      data: {
        // Prisma's types require the tenant column on create. Supplying it is
        // safe: the guard rejects any value other than the active tenant.
        schoolId,
        name: dto.name,
        level: dto.level,
      },
      include: WITH_ARM_COUNT,
    });

    return this.toDto(created, 0);
  }

  async list(query: QueryClassesDto): Promise<PaginatedDto<ClassDto>> {
    const where: Prisma.ClassWhereInput = query.search
      ? { name: { contains: query.search, mode: 'insensitive' } }
      : {};

    const [rows, total] = await Promise.all([
      this.prisma.class.findMany({
        where,
        orderBy: { [query.sortBy]: query.sortOrder },
        skip: query.skip,
        take: query.limit,
        include: WITH_ARM_COUNT,
      }),
      this.prisma.class.count({ where }),
    ]);

    const counts = await this.activeStudentCounts(rows.map((row) => row.id));

    return paginate(
      rows.map((row) => this.toDto(row, counts.get(row.id) ?? 0)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(id: string): Promise<ClassDto> {
    const row = await this.getOrThrow(id);
    const counts = await this.activeStudentCounts([id]);
    return this.toDto(row, counts.get(id) ?? 0);
  }

  async update(id: string, dto: UpdateClassDto): Promise<ClassDto> {
    const existing = await this.getOrThrow(id);

    if (dto.name && dto.name !== existing.name) {
      await this.assertNameFree(dto.name);
    }
    if (dto.level !== undefined && dto.level !== existing.level) {
      await this.assertLevelFree(dto.level);
    }

    const updated = await this.prisma.class.update({
      where: { id },
      data: { name: dto.name, level: dto.level },
      include: WITH_ARM_COUNT,
    });

    const counts = await this.activeStudentCounts([id]);
    return this.toDto(updated, counts.get(id) ?? 0);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.getOrThrow(id);

    // Arms cascade in the schema, which would silently orphan their students.
    // Make the caller empty the class first so the loss is never a surprise.
    if (existing._count.arms > 0) {
      throw AppException.conflict(
        `This class still has ${existing._count.arms} arm(s). Delete them first.`,
      );
    }

    await this.prisma.class.delete({ where: { id } });
  }

  private async getOrThrow(id: string): Promise<ClassRow> {
    const found = await this.prisma.class.findUnique({
      where: { id },
      include: WITH_ARM_COUNT,
    });

    if (!found) {
      throw AppException.notFound('Class');
    }

    return found;
  }

  /**
   * Students hang off arms, not classes, so the count is one grouped query
   * rather than a per-row lookup.
   */
  private async activeStudentCounts(
    classIds: string[],
  ): Promise<Map<string, number>> {
    if (classIds.length === 0) return new Map();

    const grouped = await this.prisma.classArm.findMany({
      where: { classId: { in: classIds } },
      select: {
        classId: true,
        // Filtered count: a graduated or withdrawn student is still on the arm
        // but should not inflate the class roll.
        _count: {
          select: { students: { where: { status: StudentStatus.ACTIVE } } },
        },
      },
    });

    const counts = new Map<string, number>();
    for (const arm of grouped) {
      counts.set(
        arm.classId,
        (counts.get(arm.classId) ?? 0) + arm._count.students,
      );
    }
    return counts;
  }

  private async assertNameFree(name: string): Promise<void> {
    const clash = await this.prisma.class.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });

    if (clash) {
      throw AppException.duplicate(`A class named "${name}" already exists`);
    }
  }

  /**
   * Level is unique per school because promotion walks it: level n moves to
   * level n + 1. Two classes sharing a level would make that ambiguous.
   */
  private async assertLevelFree(level: number): Promise<void> {
    const clash = await this.prisma.class.findFirst({
      where: { level },
      select: { name: true },
    });

    if (clash) {
      throw AppException.duplicate(
        `Level ${level} is already used by "${clash.name}"`,
      );
    }
  }

  private toDto(row: ClassRow, studentCount: number): ClassDto {
    return {
      id: row.id,
      name: row.name,
      level: row.level,
      armCount: row._count.arms,
      studentCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
