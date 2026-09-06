import { Injectable } from '@nestjs/common';
import { PaymentStatus, Prisma, StudentFeeStatus } from '@prisma/client';
import { RequestContext } from '../common/context/request-context';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma, TxClient } from '../database/prisma.service';
import {
  PaymentDto,
  QueryPaymentsDto,
  RecordPaymentDto,
  RejectPaymentDto,
} from './dto/payment.dto';
import { balance, deriveStatus, payable, sum, toAmount } from './fee-math';
import { formatReceiptNumber, nextReceiptSequence } from './receipt-number';
import { StudentFeesService } from './student-fees.service';

const WITH_DETAIL = {
  student: {
    select: { studentId: true, firstName: true, lastName: true },
  },
  studentFee: {
    select: {
      totalAmount: true,
      discountAmount: true,
      amountPaid: true,
    },
  },
} satisfies Prisma.PaymentInclude;

type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof WITH_DETAIL }>;

const RECEIPT_ATTEMPTS = 5;

@Injectable()
export class PaymentsService {
  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly invoices: StudentFeesService,
  ) {}

  /**
   * Records money against an invoice. It lands as PENDING and changes no
   * balance — that is the whole point of verification, and what stops an
   * unverified receipt from clearing a debt.
   */
  async record(dto: RecordPaymentDto, schoolId: string): Promise<PaymentDto> {
    const invoice = await this.invoices.getOrThrow(dto.studentFeeId);

    if (
      invoice.status === StudentFeeStatus.CANCELLED ||
      invoice.status === StudentFeeStatus.WAIVED
    ) {
      throw AppException.conflict(
        `This invoice is ${invoice.status} and cannot take payments`,
      );
    }

    const amount = new Prisma.Decimal(dto.amount);
    await this.assertNotOverpaying(invoice, amount);

    const created = await this.prisma.payment.create({
      data: {
        // Prisma's types require the tenant column on create. Supplying it is
        // safe: the guard rejects any value other than the active tenant.
        schoolId,
        studentFeeId: invoice.id,
        studentId: invoice.studentId,
        // Placeholder until verification issues the real one; the column is
        // unique per school, so it has to be unique even while pending.
        receiptNumber: `PENDING-${crypto.randomUUID()}`,
        amount,
        method: dto.method,
        reference: dto.reference ?? null,
        evidenceUrl: dto.evidenceUrl ?? null,
        paidAt: dto.paidAt,
        note: dto.note ?? null,
        recordedByMembershipId: RequestContext.getAuth()?.membershipId ?? null,
      },
      include: WITH_DETAIL,
    });

    return this.toDto(created);
  }

  /**
   * Verification is the only thing that moves money on an invoice: it issues a
   * receipt number and re-derives the invoice from its verified payments.
   */
  async verify(id: string): Promise<PaymentDto> {
    const existing = await this.getOrThrow(id);
    this.assertPending(existing);

    const membershipId = RequestContext.getAuth()?.membershipId ?? null;

    for (let attempt = 0; attempt < RECEIPT_ATTEMPTS; attempt++) {
      const receiptNumber = await this.nextReceiptNumber(existing.paidAt);

      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.payment.update({
            where: { id },
            data: {
              status: PaymentStatus.VERIFIED,
              receiptNumber,
              verifiedAt: new Date(),
              verifiedByMembershipId: membershipId,
              rejectionReason: null,
            },
          });

          await this.recalculateInvoice(tx, existing.studentFeeId);
        });

        return this.findOne(id);
      } catch (error) {
        // Two bursars verifying at once can pick the same number; the unique
        // index is the real guard, so take the next one and try again.
        if (!this.isUniqueViolation(error)) throw error;
      }
    }

    throw AppException.conflict(
      'Could not allocate a receipt number. Please retry.',
    );
  }

  /** Rejecting a verified payment reverses it, so the balance follows. */
  async reject(id: string, dto: RejectPaymentDto): Promise<PaymentDto> {
    const existing = await this.getOrThrow(id);

    if (existing.status === PaymentStatus.REJECTED) {
      throw AppException.conflict('This payment is already rejected');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id },
        data: {
          status: PaymentStatus.REJECTED,
          rejectionReason: dto.reason,
          verifiedByMembershipId:
            RequestContext.getAuth()?.membershipId ?? null,
          verifiedAt: new Date(),
        },
      });

      await this.recalculateInvoice(tx, existing.studentFeeId);
    });

    return this.findOne(id);
  }

  async list(query: QueryPaymentsDto): Promise<PaginatedDto<PaymentDto>> {
    const where: Prisma.PaymentWhereInput = {
      ...(query.studentId ? { studentId: query.studentId } : {}),
      ...(query.studentFeeId ? { studentFeeId: query.studentFeeId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.method ? { method: query.method } : {}),
      ...(query.paidFrom || query.paidTo
        ? {
            paidAt: {
              ...(query.paidFrom ? { gte: query.paidFrom } : {}),
              ...(query.paidTo ? { lte: query.paidTo } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              {
                receiptNumber: { contains: query.search, mode: 'insensitive' },
              },
              { reference: { contains: query.search, mode: 'insensitive' } },
              {
                student: {
                  OR: [
                    {
                      firstName: {
                        contains: query.search,
                        mode: 'insensitive',
                      },
                    },
                    {
                      lastName: { contains: query.search, mode: 'insensitive' },
                    },
                    {
                      studentId: {
                        contains: query.search,
                        mode: 'insensitive',
                      },
                    },
                  ],
                },
              },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { [query.sortBy]: query.sortOrder },
        skip: query.skip,
        take: query.limit,
        include: WITH_DETAIL,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toDto(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(id: string): Promise<PaymentDto> {
    return this.toDto(await this.getOrThrow(id));
  }

  /**
   * Recomputes an invoice from its VERIFIED payments rather than adding or
   * subtracting a delta. Rebuilding from the source cannot drift, and it makes
   * rejecting an already-verified payment fall out for free.
   */
  private async recalculateInvoice(
    tx: TxClient,
    studentFeeId: string,
  ): Promise<void> {
    const invoice = await tx.studentFee.findUniqueOrThrow({
      where: { id: studentFeeId },
      select: {
        totalAmount: true,
        discountAmount: true,
        status: true,
      },
    });

    const verified = await tx.payment.findMany({
      where: { studentFeeId, status: PaymentStatus.VERIFIED },
      select: { amount: true },
    });

    const amountPaid = sum(verified.map((row) => row.amount));

    await tx.studentFee.update({
      where: { id: studentFeeId },
      data: {
        amountPaid,
        status: deriveStatus(
          {
            totalAmount: invoice.totalAmount,
            discountAmount: invoice.discountAmount,
            amountPaid,
          },
          invoice.status,
        ),
      },
    });
  }

  private async nextReceiptNumber(paidAt: Date): Promise<string> {
    const year = paidAt.getUTCFullYear();

    const issued = await this.prisma.payment.findMany({
      where: { receiptNumber: { startsWith: `RCP/${year}/` } },
      select: { receiptNumber: true },
    });

    return formatReceiptNumber(
      year,
      nextReceiptSequence(
        issued.map((row) => row.receiptNumber),
        year,
      ),
    );
  }

  /**
   * Pending payments count toward the ceiling: two bursars each recording the
   * full balance should not both be accepted and then both verified.
   */
  private async assertNotOverpaying(
    invoice: {
      id: string;
      totalAmount: Prisma.Decimal;
      discountAmount: Prisma.Decimal;
      amountPaid: Prisma.Decimal;
    },
    amount: Prisma.Decimal,
  ): Promise<void> {
    const pending = await this.prisma.payment.findMany({
      where: { studentFeeId: invoice.id, status: PaymentStatus.PENDING },
      select: { amount: true },
    });

    const committed = invoice.amountPaid.add(
      sum(pending.map((row) => row.amount)),
    );
    const outstanding = payable(invoice).sub(committed);

    if (amount.greaterThan(outstanding)) {
      throw AppException.badRequest(
        `That is more than the ₦${outstanding.toFixed(2)} still outstanding on this invoice`,
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  private assertPending(payment: PaymentRow): void {
    if (payment.status === PaymentStatus.VERIFIED) {
      throw AppException.conflict('This payment is already verified');
    }
    if (payment.status === PaymentStatus.REJECTED) {
      throw AppException.conflict(
        'This payment was rejected. Record a new one instead of verifying it.',
      );
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private async getOrThrow(id: string): Promise<PaymentRow> {
    const found = await this.prisma.payment.findUnique({
      where: { id },
      include: WITH_DETAIL,
    });

    if (!found) {
      throw AppException.notFound('Payment');
    }

    return found;
  }

  private toDto(row: PaymentRow): PaymentDto {
    return {
      id: row.id,
      studentFeeId: row.studentFeeId,
      studentId: row.studentId,
      studentName: `${row.student.lastName}, ${row.student.firstName}`,
      admissionNumber: row.student.studentId,
      // A pending payment holds a placeholder, which is not a receipt.
      receiptNumber:
        row.status === PaymentStatus.VERIFIED ? row.receiptNumber : null,
      amount: toAmount(row.amount),
      method: row.method,
      reference: row.reference,
      evidenceUrl: row.evidenceUrl,
      paidAt: row.paidAt,
      status: row.status,
      note: row.note,
      verifiedAt: row.verifiedAt,
      rejectionReason: row.rejectionReason,
      invoiceBalance: toAmount(balance(row.studentFee)),
      createdAt: row.createdAt,
    };
  }
}
