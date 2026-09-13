import { Injectable } from '@nestjs/common';
import { PaymentStatus, Prisma, StudentFeeStatus } from '@prisma/client';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { amountInWords } from './amount-in-words';
import {
  DocumentStudentDto,
  ReceiptDto,
  SchoolLetterheadDto,
  StatementDto,
  StatementQueryDto,
} from './dto/document.dto';
import { ZERO, balance, payable, sum, toAmount } from './fee-math';
import { buildLedger } from './statement-ledger';

const STUDENT_SUMMARY = {
  id: true,
  studentId: true,
  firstName: true,
  lastName: true,
  middleName: true,
  classArm: { select: { name: true, class: { select: { name: true } } } },
} satisfies Prisma.StudentSelect;

type StudentSummary = Prisma.StudentGetPayload<{
  select: typeof STUDENT_SUMMARY;
}>;

/**
 * Printable finance documents: the receipt a parent keeps, and the statement a
 * bursar hands over when the question is "what do we owe?". Both are built
 * entirely from records on file, so neither can say something the ledger does
 * not. The parent portal renders the same documents, scoped to its own wards.
 */
@Injectable()
export class FinanceDocumentsService {
  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  async receipt(paymentId: string): Promise<ReceiptDto> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        student: { select: STUDENT_SUMMARY },
        studentFee: {
          include: {
            structure: {
              select: {
                name: true,
                session: { select: { name: true } },
                term: { select: { name: true } },
              },
            },
          },
        },
      },
    });

    if (!payment) {
      throw AppException.notFound('Payment');
    }
    // An unverified payment has no receipt: that is the whole point of
    // verification, and printing one would defeat it.
    if (payment.status !== PaymentStatus.VERIFIED || !payment.verifiedAt) {
      throw AppException.conflict(
        `Only a verified payment has a receipt; this one is ${payment.status}`,
      );
    }

    const invoice = payment.studentFee;
    const invoicePayable = payable(invoice);

    // Balance *as at this receipt*, not today: a receipt reprinted next month
    // must still show what was owed the moment this payment cleared.
    const earlier = await this.prisma.payment.findMany({
      where: {
        studentFeeId: invoice.id,
        status: PaymentStatus.VERIFIED,
        verifiedAt: { lte: payment.verifiedAt },
      },
      select: { amount: true },
    });
    const paidToDate = sum(earlier.map((row) => row.amount));
    const remaining = invoicePayable.sub(paidToDate);

    const structure = invoice.structure;
    const period = [structure.term?.name, structure.session.name]
      .filter(Boolean)
      .join(' term, ');

    return {
      receiptNumber: payment.receiptNumber,
      issuedAt: payment.verifiedAt,
      school: await this.letterhead(),
      student: this.studentDto(payment.student),
      invoiceId: invoice.id,
      feeDescription: `${structure.name} (${period})`,
      amount: toAmount(payment.amount),
      amountInWords: amountInWords(payment.amount),
      method: payment.method,
      reference: payment.reference,
      paidAt: payment.paidAt,
      invoicePayable: toAmount(invoicePayable),
      paidToDate: toAmount(paidToDate),
      balanceAfter: toAmount(remaining.isNegative() ? ZERO : remaining),
      receivedBy: await this.staffName(payment.verifiedByMembershipId),
    };
  }

  async statement(
    studentId: string,
    query: StatementQueryDto = {},
  ): Promise<StatementDto> {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: STUDENT_SUMMARY,
    });

    if (!student) {
      throw AppException.notFound('Student');
    }

    const invoices = await this.prisma.studentFee.findMany({
      where: {
        studentId,
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
        ...(query.termId ? { termId: query.termId } : {}),
      },
      include: { structure: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    const payments = await this.prisma.payment.findMany({
      where: { studentFeeId: { in: invoices.map((invoice) => invoice.id) } },
      orderBy: { paidAt: 'asc' },
    });

    const { entries, closingBalance } = buildLedger(
      invoices.map((invoice) => ({
        ...invoice,
        structureName: invoice.structure.name,
      })),
      payments,
    );

    const live = invoices.filter(
      (invoice) => invoice.status !== StudentFeeStatus.CANCELLED,
    );
    const waived = entries
      .filter((entry) => entry.type === 'WAIVER')
      .map((entry) => entry.credit);

    return {
      school: await this.letterhead(),
      student: this.studentDto(student),
      generatedAt: new Date(),
      totalBilled: toAmount(sum(live.map((invoice) => invoice.totalAmount))),
      totalDiscounted: toAmount(
        sum(live.map((invoice) => invoice.discountAmount)),
      ),
      totalPaid: toAmount(sum(live.map((invoice) => invoice.amountPaid))),
      totalWaived: toAmount(sum(waived)),
      closingBalance: toAmount(closingBalance),
      pendingVerification: toAmount(
        sum(
          payments
            .filter((row) => row.status === PaymentStatus.PENDING)
            .map((row) => row.amount),
        ),
      ),
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        structureName: invoice.structure.name,
        totalAmount: toAmount(invoice.totalAmount),
        discountAmount: toAmount(invoice.discountAmount),
        amountPaid: toAmount(invoice.amountPaid),
        balance: toAmount(
          invoice.status === StudentFeeStatus.WAIVED ||
            invoice.status === StudentFeeStatus.CANCELLED
            ? ZERO
            : balance(invoice),
        ),
        status: invoice.status,
        dueDate: invoice.dueDate,
      })),
      ledger: entries.map((entry) => ({
        date: entry.date,
        type: entry.type,
        description: entry.description,
        debit: toAmount(entry.debit),
        credit: toAmount(entry.credit),
        balance: toAmount(entry.balance),
        reference: entry.reference,
      })),
      payments: payments.map((row) => ({
        id: row.id,
        receiptNumber:
          row.status === PaymentStatus.VERIFIED ? row.receiptNumber : null,
        amount: toAmount(row.amount),
        method: row.method,
        status: row.status,
        paidAt: row.paidAt,
        rejectionReason: row.rejectionReason,
      })),
    };
  }

  private async letterhead(): Promise<SchoolLetterheadDto> {
    const schoolId = RequestContext.getTenantId();
    const school = schoolId
      ? await this.prisma.school.findUnique({ where: { id: schoolId } })
      : null;

    if (!school) {
      throw AppException.notFound('School');
    }

    return {
      name: school.name,
      addressLine: school.addressLine,
      city: school.city,
      state: school.state,
      phone: school.phone,
      email: school.email,
      logoUrl: school.logoUrl,
      motto: school.motto,
    };
  }

  private studentDto(student: StudentSummary): DocumentStudentDto {
    const middle = student.middleName ? ` ${student.middleName}` : '';
    return {
      id: student.id,
      admissionNumber: student.studentId,
      fullName: `${student.lastName}, ${student.firstName}${middle}`,
      className: student.classArm
        ? `${student.classArm.class.name} ${student.classArm.name}`
        : null,
    };
  }

  private async staffName(membershipId: string | null): Promise<string | null> {
    if (!membershipId) return null;

    const membership = await this.prisma.membership.findUnique({
      where: { id: membershipId },
      select: { user: { select: { firstName: true, lastName: true } } },
    });

    return membership
      ? `${membership.user.firstName} ${membership.user.lastName}`
      : null;
  }
}
