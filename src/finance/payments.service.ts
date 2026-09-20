import { Injectable } from '@nestjs/common';
import {
  NotificationType,
  PaymentStatus,
  Prisma,
  StudentFeeStatus,
} from '@prisma/client';
import { RequestContext } from '../common/context/request-context';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma, TxClient } from '../database/prisma.service';
import { lockRow } from '../database/row-lock';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import { SchoolSettingsService } from '../tenants/school-settings.service';
import { naira } from './naira';
import {
  PaymentDto,
  QueryPaymentsDto,
  RecordPaymentDto,
  RejectPaymentDto,
} from './dto/payment.dto';
import { balance, deriveStatus, payable, sum, toAmount } from './fee-math';
import { formatReceiptNumber, nextReceiptSequence } from './receipt-number';

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
    private readonly notifications: InAppNotificationsService,
    private readonly settings: SchoolSettingsService,
  ) {}

  /**
   * Records money against an invoice. It lands as PENDING and changes no
   * balance — that is the whole point of verification, and what stops an
   * unverified receipt from clearing a debt.
   */
  async record(dto: RecordPaymentDto, schoolId: string): Promise<PaymentDto> {
    const amount = new Prisma.Decimal(dto.amount);

    const created = await this.prisma.$transaction(async (tx) => {
      // The ceiling check reads every pending payment on the invoice; the lock
      // stops a second recording from slipping in between that read and the
      // insert, which is how two full-balance claims were both accepted.
      if (!(await lockRow(tx, 'studentFee', dto.studentFeeId))) {
        throw AppException.notFound('Invoice');
      }

      const invoice = await tx.studentFee.findUniqueOrThrow({
        where: { id: dto.studentFeeId },
      });

      if (
        invoice.status === StudentFeeStatus.CANCELLED ||
        invoice.status === StudentFeeStatus.WAIVED
      ) {
        throw AppException.conflict(
          `This invoice is ${invoice.status} and cannot take payments`,
        );
      }

      await this.assertNotOverpaying(tx, invoice, amount);

      return tx.payment.create({
        data: {
          // Prisma's types require the tenant column on create. Supplying it
          // is safe: the guard rejects any value other than the active tenant.
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
          recordedByMembershipId:
            RequestContext.getAuth()?.membershipId ?? null,
        },
        include: WITH_DETAIL,
      });
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
      try {
        await this.prisma.$transaction(async (tx) => {
          // Serialise every writer to this invoice. Without the lock, two
          // payments verified together each recompute the balance before the
          // other commits, and one of them silently drops out of amountPaid.
          await lockRow(tx, 'studentFee', existing.studentFeeId);

          const receiptNumber = await this.nextReceiptNumber(
            tx,
            existing.paidAt,
          );

          // Conditional on still being PENDING, so a double-click verifies
          // exactly once: the loser matches no row and is told so.
          const { count } = await tx.payment.updateMany({
            where: { id, status: PaymentStatus.PENDING },
            data: {
              status: PaymentStatus.VERIFIED,
              receiptNumber,
              verifiedAt: new Date(),
              verifiedByMembershipId: membershipId,
              rejectionReason: null,
            },
          });
          if (count === 0) {
            throw AppException.conflict('This payment is no longer pending');
          }

          await this.recalculateInvoice(tx, existing.studentFeeId);
        });

        const verified = await this.findOne(id);
        await this.notifications.notifyParentsOf([
          {
            studentId: verified.studentId,
            draft: {
              type: NotificationType.PAYMENT_VERIFIED,
              title: 'Payment received',
              body: `${naira(verified.amount)} for ${verified.studentName} has been confirmed. Receipt ${verified.receiptNumber}; balance now ${naira(verified.invoiceBalance)}.`,
              data: { paymentId: verified.id },
            },
          },
        ]);
        return verified;
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
      await lockRow(tx, 'studentFee', existing.studentFeeId);

      const { count } = await tx.payment.updateMany({
        where: { id, status: { not: PaymentStatus.REJECTED } },
        data: {
          status: PaymentStatus.REJECTED,
          rejectionReason: dto.reason,
          verifiedByMembershipId:
            RequestContext.getAuth()?.membershipId ?? null,
          verifiedAt: new Date(),
        },
      });
      if (count === 0) {
        throw AppException.conflict('This payment is already rejected');
      }

      await this.recalculateInvoice(tx, existing.studentFeeId);
    });

    const rejected = await this.findOne(id);
    await this.notifications.notifyParentsOf([
      {
        studentId: rejected.studentId,
        draft: {
          type: NotificationType.PAYMENT_REJECTED,
          title: 'Payment could not be confirmed',
          body: `${naira(rejected.amount)} for ${rejected.studentName} was not confirmed: ${dto.reason}. Please contact the school office.`,
          data: { paymentId: rejected.id },
        },
      },
    ]);
    return rejected;
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

  private async nextReceiptNumber(tx: TxClient, paidAt: Date): Promise<string> {
    const year = paidAt.getUTCFullYear();

    // Matched on the year, not the prefix: a school that changes its prefix
    // must carry on from the last number, not start again at one.
    const issued = await tx.payment.findMany({
      where: { receiptNumber: { contains: `/${year}/` } },
      select: { receiptNumber: true },
    });

    return formatReceiptNumber(
      year,
      nextReceiptSequence(
        issued.map((row) => row.receiptNumber),
        year,
      ),
      (await this.settings.current()).receiptPrefix,
    );
  }

  /**
   * Pending payments count toward the ceiling: two bursars each recording the
   * full balance should not both be accepted and then both verified.
   */
  private async assertNotOverpaying(
    tx: TxClient,
    invoice: {
      id: string;
      totalAmount: Prisma.Decimal;
      discountAmount: Prisma.Decimal;
      amountPaid: Prisma.Decimal;
    },
    amount: Prisma.Decimal,
  ): Promise<void> {
    const pending = await tx.payment.findMany({
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
