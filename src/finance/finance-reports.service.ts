import { Injectable } from '@nestjs/common';
import { PaymentStatus, Prisma, StudentFeeStatus } from '@prisma/client';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import {
  CollectionReportDto,
  DebtorDto,
  DebtorQueryDto,
  FinanceReportQueryDto,
} from './dto/report.dto';
import { OWING_STATUSES, ZERO, balance, sum, toAmount } from './fee-math';

const OWING_INVOICE = {
  student: {
    select: {
      id: true,
      studentId: true,
      firstName: true,
      lastName: true,
      classArm: { select: { name: true, class: { select: { name: true } } } },
      guardians: {
        include: {
          guardian: {
            select: { firstName: true, lastName: true, email: true },
          },
        },
        orderBy: { isPrimary: 'desc' },
      },
    },
  },
} satisfies Prisma.StudentFeeInclude;

export type OwingInvoice = Prisma.StudentFeeGetPayload<{
  include: typeof OWING_INVOICE;
}>;

@Injectable()
export class FinanceReportsService {
  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  /**
   * The headline numbers. Everything is derived from invoices and verified
   * payments, so the report can never disagree with the ledger it summarises.
   */
  async summary(query: FinanceReportQueryDto): Promise<CollectionReportDto> {
    const where = this.invoiceWhere(query);

    const [totals, invoiceCount, debtorCount, students, byMethod, pending] =
      await Promise.all([
        this.prisma.studentFee.aggregate({
          where,
          _sum: {
            totalAmount: true,
            discountAmount: true,
            amountPaid: true,
          },
        }),
        this.prisma.studentFee.count({ where }),
        this.prisma.studentFee.count({
          where: { ...where, status: { in: [...OWING_STATUSES] } },
        }),
        this.prisma.studentFee.findMany({
          where,
          select: { studentId: true },
          distinct: ['studentId'],
        }),
        this.prisma.payment.groupBy({
          by: ['method'],
          where: { status: PaymentStatus.VERIFIED, studentFee: where },
          _sum: { amount: true },
          _count: { _all: true },
        }),
        this.prisma.payment.aggregate({
          where: { status: PaymentStatus.PENDING, studentFee: where },
          _sum: { amount: true },
        }),
      ]);

    const billed = totals._sum.totalAmount ?? ZERO;
    const discounted = totals._sum.discountAmount ?? ZERO;
    const collected = totals._sum.amountPaid ?? ZERO;
    const payable = billed.sub(discounted);

    // Waived and cancelled invoices are not debts, so they must not appear as
    // outstanding even though they were billed.
    const outstanding = await this.outstandingTotal(where);

    return {
      invoiceCount,
      studentCount: students.length,
      totalBilled: toAmount(billed),
      totalDiscounted: toAmount(discounted),
      totalPayable: toAmount(payable),
      totalCollected: toAmount(collected),
      totalOutstanding: toAmount(outstanding),
      pendingVerification: toAmount(pending._sum.amount ?? ZERO),
      collectionRate: payable.isZero()
        ? 100
        : Number(collected.div(payable).mul(100).toDecimalPlaces(1)),
      debtorCount,
      byMethod: byMethod.map((row) => ({
        method: row.method,
        count: row._count._all,
        total: toAmount(row._sum.amount ?? ZERO),
      })),
    };
  }

  /** One row per student, aggregating everything they still owe. */
  async debtors(query: DebtorQueryDto): Promise<PaginatedDto<DebtorDto>> {
    const invoices = await this.owingInvoices(query);
    const byStudent = this.groupByStudent(invoices);

    const minBalance = new Prisma.Decimal(query.minBalance ?? 0);
    let rows = [...byStudent.values()].filter((row) =>
      new Prisma.Decimal(row.totalOwed).gte(minBalance),
    );

    if (query.overdueOnly) {
      rows = rows.filter((row) => row.isOverdue);
    }
    if (query.search) {
      const needle = query.search.toLowerCase();
      rows = rows.filter(
        (row) =>
          row.studentName.toLowerCase().includes(needle) ||
          row.admissionNumber.toLowerCase().includes(needle),
      );
    }

    // Biggest debts first: that is the list a bursar acts on.
    rows.sort((a, b) => b.totalOwed - a.totalOwed);

    const start = query.skip;
    return paginate(
      rows.slice(start, start + query.limit),
      rows.length,
      query.page,
      query.limit,
    );
  }

  /** Shared with the reminder service so both act on the same definition. */
  async owingInvoices(query: {
    sessionId?: string;
    termId?: string;
    classArmId?: string;
    studentIds?: string[];
  }): Promise<OwingInvoice[]> {
    return this.prisma.studentFee.findMany({
      where: {
        status: { in: [...OWING_STATUSES] },
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
        ...(query.termId ? { termId: query.termId } : {}),
        ...(query.classArmId
          ? { student: { classArmId: query.classArmId } }
          : {}),
        ...(query.studentIds ? { studentId: { in: query.studentIds } } : {}),
      },
      include: OWING_INVOICE,
    });
  }

  groupByStudent(invoices: OwingInvoice[]): Map<string, DebtorDto> {
    const today = new Date();
    const byStudent = new Map<string, DebtorDto>();

    for (const invoice of invoices) {
      const owed = balance(invoice);
      if (owed.isZero()) continue;

      const student = invoice.student;
      const arm = student.classArm;
      const existing = byStudent.get(student.id);
      const overdue = invoice.dueDate !== null && invoice.dueDate < today;

      if (existing) {
        existing.totalOwed = toAmount(
          new Prisma.Decimal(existing.totalOwed).add(owed),
        );
        existing.invoiceCount += 1;
        existing.isOverdue = existing.isOverdue || overdue;
        existing.earliestDueDate = this.earlier(
          existing.earliestDueDate,
          invoice.dueDate,
        );
        continue;
      }

      byStudent.set(student.id, {
        studentId: student.id,
        admissionNumber: student.studentId,
        studentName: `${student.lastName}, ${student.firstName}`,
        className: arm ? `${arm.class.name} ${arm.name}` : null,
        totalOwed: toAmount(owed),
        invoiceCount: 1,
        earliestDueDate: invoice.dueDate,
        isOverdue: overdue,
        guardianContacts: student.guardians
          .map((link) => link.guardian.email)
          .filter((email): email is string => Boolean(email)),
      });
    }

    return byStudent;
  }

  private async outstandingTotal(
    where: Prisma.StudentFeeWhereInput,
  ): Promise<Prisma.Decimal> {
    const owing = await this.prisma.studentFee.findMany({
      where: { ...where, status: { in: [...OWING_STATUSES] } },
      select: {
        totalAmount: true,
        discountAmount: true,
        amountPaid: true,
      },
    });

    return sum(owing.map((invoice) => balance(invoice)));
  }

  private invoiceWhere(
    query: FinanceReportQueryDto,
  ): Prisma.StudentFeeWhereInput {
    return {
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.termId ? { termId: query.termId } : {}),
      ...(query.classArmId
        ? { student: { classArmId: query.classArmId } }
        : {}),
      ...(query.classId
        ? { student: { classArm: { classId: query.classId } } }
        : {}),
      // Cancelled invoices were withdrawn, so they are not part of the picture.
      NOT: { status: StudentFeeStatus.CANCELLED },
    };
  }

  private earlier(a: Date | null, b: Date | null): Date | null {
    if (!a) return b;
    if (!b) return a;
    return a < b ? a : b;
  }
}
