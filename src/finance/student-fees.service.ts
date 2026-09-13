import { Injectable } from '@nestjs/common';
import {
  PaymentStatus,
  Prisma,
  StudentFee,
  StudentFeeStatus,
  StudentStatus,
} from '@prisma/client';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma, TxClient } from '../database/prisma.service';
import { lockRow } from '../database/row-lock';
import {
  AssignFeeDto,
  AssignFeeResultDto,
  DiscountFeeDto,
  QueryStudentFeesDto,
  StudentFeeDto,
  WaiveFeeDto,
} from './dto/student-fee.dto';
import {
  OWING_STATUSES,
  balance,
  deriveStatus,
  payable,
  sum,
  toAmount,
} from './fee-math';
import { FeeStructuresService } from './fee-structures.service';

const WITH_DETAIL = {
  student: {
    select: {
      studentId: true,
      firstName: true,
      lastName: true,
      classArm: { select: { name: true, class: { select: { name: true } } } },
    },
  },
  structure: { select: { name: true } },
  items: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.StudentFeeInclude;

type FeeRow = Prisma.StudentFeeGetPayload<{ include: typeof WITH_DETAIL }>;

@Injectable()
export class StudentFeesService {
  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly structures: FeeStructuresService,
  ) {}

  /**
   * Issues one invoice per student from a published structure.
   *
   * Students who already hold an invoice for this structure are skipped rather
   * than failing the batch: re-running an assignment after adding a late
   * arrival is normal, and should bill only the new student.
   */
  async assign(
    dto: AssignFeeDto,
    schoolId: string,
  ): Promise<AssignFeeResultDto> {
    if (Boolean(dto.classArmId) === Boolean(dto.studentIds)) {
      throw AppException.badRequest(
        'Provide either classArmId or studentIds, not both',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const structure = await this.structures.getPublishedOrThrow(
      dto.structureId,
    );
    const students = await this.resolveStudents(dto);
    const items = this.billableItems(structure, dto.includeOptionalItemIds);
    const total = sum(items.map((item) => item.amount));

    const already = await this.prisma.studentFee.findMany({
      where: {
        structureId: dto.structureId,
        studentId: { in: students.map((s) => s.id) },
      },
      select: { studentId: true },
    });
    const billed = new Set(already.map((row) => row.studentId));
    const targets = students.filter((student) => !billed.has(student.id));

    const created: string[] = [];
    if (targets.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const student of targets) {
          const invoice = await tx.studentFee.create({
            data: {
              // Prisma's types require the tenant column on create. Supplying
              // it is safe: the guard rejects any other tenant's id.
              schoolId,
              studentId: student.id,
              structureId: structure.id,
              sessionId: structure.sessionId,
              termId: structure.termId,
              totalAmount: total,
              dueDate: dto.dueDate ?? structure.dueDate,
              status: total.isZero()
                ? StudentFeeStatus.PAID
                : StudentFeeStatus.UNPAID,
            },
          });

          // Line items are copied, not referenced: renaming or deleting a
          // category later must not rewrite a bill already issued.
          await tx.studentFeeItem.createMany({
            data: items.map((item) => ({
              schoolId,
              studentFeeId: invoice.id,
              categoryId: item.categoryId,
              categoryName: item.categoryName,
              amount: item.amount,
            })),
          });

          created.push(invoice.id);
        }
      });
    }

    const invoices = await this.prisma.studentFee.findMany({
      where: { id: { in: created } },
      include: WITH_DETAIL,
    });

    return {
      assigned: created.length,
      skipped: students.length - targets.length,
      totalBilled: toAmount(total.mul(created.length)),
      invoices: invoices.map((row) => this.toDto(row)),
    };
  }

  async list(query: QueryStudentFeesDto): Promise<PaginatedDto<StudentFeeDto>> {
    const where: Prisma.StudentFeeWhereInput = {
      ...(query.studentId ? { studentId: query.studentId } : {}),
      ...(query.structureId ? { structureId: query.structureId } : {}),
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.termId ? { termId: query.termId } : {}),
      ...(query.classArmId
        ? { student: { classArmId: query.classArmId } }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.owing === true ? { status: { in: [...OWING_STATUSES] } } : {}),
      ...(query.search
        ? {
            student: {
              OR: [
                { firstName: { contains: query.search, mode: 'insensitive' } },
                { lastName: { contains: query.search, mode: 'insensitive' } },
                { studentId: { contains: query.search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.studentFee.findMany({
        where,
        orderBy: { [query.sortBy]: query.sortOrder },
        skip: query.skip,
        take: query.limit,
        include: WITH_DETAIL,
      }),
      this.prisma.studentFee.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toDto(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(id: string): Promise<StudentFeeDto> {
    return this.toDto(await this.getOrThrow(id));
  }

  /** A scholarship or sibling discount: recorded openly, not hidden in the total. */
  async discount(id: string, dto: DiscountFeeDto): Promise<StudentFeeDto> {
    const discount = new Prisma.Decimal(dto.amount);

    return this.mutateLocked(id, async (tx, invoice) => {
      this.assertOpen(invoice);

      if (discount.greaterThan(invoice.totalAmount)) {
        throw AppException.badRequest(
          'A discount cannot exceed the amount billed',
          ErrorCode.VALIDATION_ERROR,
        );
      }

      await tx.studentFee.update({
        where: { id },
        data: {
          discountAmount: discount,
          waiverReason: dto.reason,
          // Derived from the locked row, so a payment verified a moment ago
          // is part of the calculation rather than overwritten by it.
          status: deriveStatus({ ...invoice, discountAmount: discount }),
        },
      });
    });
  }

  /** Writes the invoice off entirely, leaving it visible in the ledger. */
  async waive(id: string, dto: WaiveFeeDto): Promise<StudentFeeDto> {
    return this.mutateLocked(id, async (tx, invoice) => {
      this.assertOpen(invoice);

      await tx.studentFee.update({
        where: { id },
        data: { status: StudentFeeStatus.WAIVED, waiverReason: dto.reason },
      });
    });
  }

  /** For an invoice raised in error. Payments must be dealt with first. */
  async cancel(id: string, reason: string): Promise<StudentFeeDto> {
    return this.mutateLocked(id, async (tx, invoice) => {
      if (invoice.status === StudentFeeStatus.CANCELLED) {
        throw AppException.conflict('This invoice is already cancelled');
      }

      // Pending payments count too: one verified after cancellation would
      // leave real money attached to a bill that no longer exists.
      const live = await tx.payment.count({
        where: {
          studentFeeId: id,
          status: { in: [PaymentStatus.PENDING, PaymentStatus.VERIFIED] },
        },
      });
      if (live > 0) {
        throw AppException.conflict(
          'This invoice has payments against it. Reject those payments before cancelling.',
        );
      }

      await tx.studentFee.update({
        where: { id },
        data: { status: StudentFeeStatus.CANCELLED, waiverReason: reason },
      });
    });
  }

  /**
   * Runs a change against a locked invoice. Payments recompute the same row,
   * so every writer to an invoice goes through a lock on it.
   */
  private async mutateLocked(
    id: string,
    change: (tx: TxClient, invoice: StudentFee) => Promise<void>,
  ): Promise<StudentFeeDto> {
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'studentFee', id))) {
        throw AppException.notFound('Invoice');
      }
      const invoice = await tx.studentFee.findUniqueOrThrow({ where: { id } });
      await change(tx, invoice);
    });

    return this.findOne(id);
  }

  async getOrThrow(id: string): Promise<FeeRow> {
    const found = await this.prisma.studentFee.findUnique({
      where: { id },
      include: WITH_DETAIL,
    });

    if (!found) {
      throw AppException.notFound('Invoice');
    }

    return found;
  }

  private assertOpen(invoice: Pick<StudentFee, 'status'>): void {
    if (
      invoice.status === StudentFeeStatus.WAIVED ||
      invoice.status === StudentFeeStatus.CANCELLED
    ) {
      throw AppException.conflict(
        `This invoice is ${invoice.status} and cannot be changed`,
      );
    }
  }

  private async resolveStudents(dto: AssignFeeDto): Promise<{ id: string }[]> {
    if (dto.classArmId) {
      const students = await this.prisma.student.findMany({
        // Only active students are billed: a withdrawn student should not
        // acquire a debt after leaving.
        where: { classArmId: dto.classArmId, status: StudentStatus.ACTIVE },
        select: { id: true },
      });

      if (students.length === 0) {
        throw AppException.conflict('That arm has no active students to bill');
      }

      return students;
    }

    const students = await this.prisma.student.findMany({
      where: { id: { in: dto.studentIds }, status: StudentStatus.ACTIVE },
      select: { id: true },
    });

    if (students.length !== dto.studentIds?.length) {
      throw AppException.badRequest(
        'Some students do not exist here or are not active',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    return students;
  }

  /**
   * Compulsory items always; optional ones only where the caller asked for
   * them, which is what makes a bus place billable per family.
   */
  private billableItems(
    structure: Awaited<ReturnType<FeeStructuresService['getPublishedOrThrow']>>,
    includeOptionalItemIds: string[] | undefined,
  ): { categoryId: string; categoryName: string; amount: Prisma.Decimal }[] {
    const wanted = new Set(includeOptionalItemIds ?? []);

    const unknown = [...wanted].filter(
      (id) => !structure.items.some((item) => item.id === id),
    );
    if (unknown.length > 0) {
      throw AppException.badRequest(
        'Some optional items do not belong to this fee structure',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    return structure.items
      .filter((item) => !item.isOptional || wanted.has(item.id))
      .map((item) => ({
        categoryId: item.categoryId,
        categoryName: item.category.name,
        amount: item.amount,
      }));
  }

  private toDto(row: FeeRow): StudentFeeDto {
    const arm = row.student.classArm;

    return {
      id: row.id,
      studentId: row.studentId,
      admissionNumber: row.student.studentId,
      studentName: `${row.student.lastName}, ${row.student.firstName}`,
      className: arm ? `${arm.class.name} ${arm.name}` : null,
      structureId: row.structureId,
      structureName: row.structure.name,
      sessionId: row.sessionId,
      termId: row.termId,
      totalAmount: toAmount(row.totalAmount),
      discountAmount: toAmount(row.discountAmount),
      payableAmount: toAmount(payable(row)),
      amountPaid: toAmount(row.amountPaid),
      balance: toAmount(balance(row)),
      status: row.status,
      dueDate: row.dueDate,
      waiverReason: row.waiverReason,
      items: row.items.map((item) => ({
        id: item.id,
        categoryName: item.categoryName,
        amount: toAmount(item.amount),
      })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
