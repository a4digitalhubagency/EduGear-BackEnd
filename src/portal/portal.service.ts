import { Injectable } from '@nestjs/common';
import {
  FilePurpose,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  ResultSheetStatus,
} from '@prisma/client';
import { AttendanceService } from '../attendance/attendance.service';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { FileDto } from '../files/dto/file.dto';
import { FilesService } from '../files/files.service';
import { ReceiptDto, StatementDto } from '../finance/dto/document.dto';
import { PaymentDto } from '../finance/dto/payment.dto';
import {
  OWING_STATUSES,
  ZERO,
  balance,
  sum,
  toAmount,
} from '../finance/fee-math';
import { FinanceDocumentsService } from '../finance/finance-documents.service';
import { PaymentsService } from '../finance/payments.service';
import { PaystackService } from '../finance/paystack/paystack.service';
import { ReportCardDto } from '../results/dto/report-card.dto';
import { ordinal } from '../results/ranking';
import { ReportCardsService } from '../results/report-cards.service';
import { SchoolSettingsService } from '../tenants/school-settings.service';
import {
  StartOnlinePaymentDto,
  StartedPaymentResponseDto,
} from '../finance/dto/payment.dto';
import {
  PortalChildDto,
  PortalLatestResultDto,
  PortalMeDto,
  PortalOverviewDto,
  PortalResultTermDto,
  SubmitPaymentDto,
} from './dto/portal.dto';

/**
 * What a parent sees.
 *
 * The PARENT role's one permission, portal.access, gets a parent through the
 * door; which children they may see is decided here, on every request, from
 * their guardian links. Another parent's child in the same school is answered
 * with 404 — not 403 — so the portal never confirms that a child exists.
 */
@Injectable()
export class PortalService {
  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly documents: FinanceDocumentsService,
    private readonly payments: PaymentsService,
    private readonly paystack: PaystackService,
    private readonly reportCards: ReportCardsService,
    private readonly attendance: AttendanceService,
    private readonly settings: SchoolSettingsService,
    private readonly files: FilesService,
  ) {}

  async me(): Promise<PortalMeDto> {
    const guardian = await this.guardian();
    const [children, school, unread] = await Promise.all([
      this.children(),
      this.prisma.school.findFirst({ select: { name: true } }),
      this.prisma.notification.count({
        where: { userId: RequestContext.getAuth()!.userId, readAt: null },
      }),
    ]);

    return {
      guardianId: guardian.id,
      fullName: `${guardian.firstName} ${guardian.lastName}`,
      phone: guardian.phone,
      email: guardian.email,
      schoolName: school?.name ?? '',
      children,
      unreadNotifications: unread,
    };
  }

  async children(): Promise<PortalChildDto[]> {
    const guardian = await this.guardian();
    const links = await this.prisma.studentGuardian.findMany({
      where: { guardianId: guardian.id },
      select: { studentId: true },
    });
    return Promise.all(links.map((link) => this.childSummary(link.studentId)));
  }

  async overview(studentId: string): Promise<PortalOverviewDto> {
    await this.assertWard(studentId);

    const [summary, student, currentTerm] = await Promise.all([
      this.childSummary(studentId),
      this.prisma.student.findUniqueOrThrow({
        where: { id: studentId },
        select: { classArm: { select: { formTeacherId: true } } },
      }),
      this.prisma.term.findFirst({
        where: { isCurrent: true },
        select: { id: true, name: true },
      }),
    ]);

    const formTeacherId = student.classArm?.formTeacherId;
    const formTeacher = formTeacherId
      ? await this.prisma.membership.findUnique({
          where: { id: formTeacherId },
          select: { user: { select: { firstName: true, lastName: true } } },
        })
      : null;

    return {
      ...summary,
      formTeacherName: formTeacher
        ? `${formTeacher.user.firstName} ${formTeacher.user.lastName}`
        : null,
      currentTermId: currentTerm?.id ?? null,
      currentTermName: currentTerm?.name ?? null,
      attendance: currentTerm
        ? await this.attendance.studentTermSummary(studentId, currentTerm.id)
        : null,
    };
  }

  async statement(studentId: string): Promise<StatementDto> {
    await this.assertWard(studentId);
    return this.documents.statement(studentId);
  }

  async receipt(studentId: string, paymentId: string): Promise<ReceiptDto> {
    await this.assertWard(studentId);
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { studentId: true },
    });
    // A payment for a different child is as absent as one that does not exist.
    if (!payment || payment.studentId !== studentId) {
      throw AppException.notFound('Payment');
    }
    return this.documents.receipt(paymentId);
  }

  /**
   * A parent sends proof of a transfer. It lands PENDING like any recorded
   * payment and moves nothing until the bursar verifies it against the bank —
   * which is the survey's unverified-receipt problem, handled at the source.
   */
  async submitPayment(
    studentId: string,
    dto: SubmitPaymentDto,
    schoolId: string,
  ): Promise<PaymentDto> {
    await this.assertWard(studentId);

    if (dto.method === PaymentMethod.CASH) {
      throw AppException.badRequest(
        'Cash is paid at the school office and recorded there',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const invoice = await this.prisma.studentFee.findUnique({
      where: { id: dto.studentFeeId },
      select: { studentId: true },
    });
    if (!invoice || invoice.studentId !== studentId) {
      throw AppException.notFound('Invoice');
    }

    return this.payments.record(
      {
        studentFeeId: dto.studentFeeId,
        amount: dto.amount,
        method: dto.method,
        reference: dto.reference,
        evidenceUrl: dto.evidenceUrl ?? null,
        paidAt: dto.paidAt,
        note: 'Submitted by a parent through the portal',
      },
      schoolId,
    );
  }

  /**
   * Pays a child's invoice by card. The parent never names a school and never
   * names a payer: the invoice must belong to their own child, and the amount
   * is checked against it before the provider is asked for anything.
   */
  async startOnlinePayment(
    studentId: string,
    dto: StartOnlinePaymentDto,
    schoolId: string,
  ): Promise<StartedPaymentResponseDto> {
    await this.assertWard(studentId);

    const invoice = await this.prisma.studentFee.findUnique({
      where: { id: dto.studentFeeId },
      select: { studentId: true },
    });
    if (!invoice || invoice.studentId !== studentId) {
      throw AppException.notFound('Invoice');
    }

    const guardian = await this.guardian();
    // Paystack needs somewhere to send its own receipt. The guardian record is
    // preferred over the login because it is what the school keeps in touch on.
    const email = guardian.email ?? RequestContext.getAuth()?.email;
    if (!email) {
      throw AppException.conflict(
        'Add an email address to your profile before paying online',
      );
    }

    return this.paystack.start(dto, email, schoolId);
  }

  /** Asks the provider what happened, for a payment on the parent's own child. */
  async refreshOnlinePayment(studentId: string, paymentId: string) {
    await this.assertWard(studentId);

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { studentId: true },
    });
    if (!payment || payment.studentId !== studentId) {
      throw AppException.notFound('Payment');
    }

    return this.paystack.refresh(paymentId);
  }

  /**
   * A parent's photo of a teller. Uploaded against their own child, so the
   * same ward check that governs everything else governs who can read it back.
   */
  async uploadEvidence(
    studentId: string,
    file: Express.Multer.File | undefined,
    schoolId: string,
  ): Promise<FileDto> {
    await this.assertWard(studentId);
    if (!file) {
      throw AppException.badRequest(
        'No file was attached — send it as the "file" part',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    return this.files.upload(
      {
        buffer: file.buffer,
        originalName: file.originalname,
        declaredType: file.mimetype,
        purpose: FilePurpose.PAYMENT_EVIDENCE,
        link: { type: 'Student', id: studentId },
      },
      schoolId,
    );
  }

  async results(studentId: string): Promise<PortalResultTermDto[]> {
    await this.assertWard(studentId);

    const rows = await this.prisma.studentResult.findMany({
      where: {
        studentId,
        resultSheet: { status: ResultSheetStatus.PUBLISHED },
      },
      include: {
        resultSheet: {
          select: {
            id: true,
            publishedAt: true,
            term: {
              select: {
                id: true,
                name: true,
                startDate: true,
                session: { select: { name: true } },
              },
            },
            _count: {
              select: {
                studentResults: { where: { position: { not: null } } },
              },
            },
          },
        },
      },
    });

    return rows
      .sort(
        (a, b) =>
          b.resultSheet.term.startDate.getTime() -
          a.resultSheet.term.startDate.getTime(),
      )
      .map((row) => ({
        ...this.resultLine(row),
        publishedAt: row.resultSheet.publishedAt,
      }));
  }

  async reportCard(studentId: string, termId: string): Promise<ReportCardDto> {
    await this.assertWard(studentId);
    // Drafts, submitted and approved sheets are all simply "not there yet".
    return this.reportCards.forStudent(studentId, termId, {
      publishedOnly: true,
    });
  }

  async attendanceFor(studentId: string, termId?: string) {
    await this.assertWard(studentId);

    const term = termId
      ? await this.prisma.term.findUnique({
          where: { id: termId },
          select: { id: true, name: true },
        })
      : await this.prisma.term.findFirst({
          where: { isCurrent: true },
          select: { id: true, name: true },
        });
    if (!term) throw AppException.notFound('Term');

    const [summary, records] = await Promise.all([
      this.attendance.studentTermSummary(studentId, term.id),
      this.attendance.studentRecords(studentId, term.id),
    ]);
    return { termId: term.id, termName: term.name, summary, records };
  }

  // ---------------------------------------------------------------------------

  private async guardian() {
    const auth = RequestContext.getAuth();
    if (!auth) throw AppException.unauthorized();

    // The school can close the portal without revoking anybody's login.
    await this.settings.assertPortalEnabled();

    const guardian = await this.prisma.guardian.findFirst({
      where: { userId: auth.userId },
    });
    if (!guardian) {
      throw AppException.forbidden(
        'Your login is not linked to any student at this school',
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }
    return guardian;
  }

  private async assertWard(studentId: string): Promise<void> {
    const guardian = await this.guardian();
    const link = await this.prisma.studentGuardian.findUnique({
      where: { studentId_guardianId: { studentId, guardianId: guardian.id } },
      select: { studentId: true },
    });
    if (!link) throw AppException.notFound('Student');
  }

  private async childSummary(studentId: string): Promise<PortalChildDto> {
    const guardian = await this.guardian();

    const [student, link, invoices, pending, latest] = await Promise.all([
      this.prisma.student.findUniqueOrThrow({
        where: { id: studentId },
        select: {
          id: true,
          studentId: true,
          firstName: true,
          lastName: true,
          middleName: true,
          gender: true,
          photoUrl: true,
          classArm: {
            select: { name: true, class: { select: { name: true } } },
          },
        },
      }),
      this.prisma.studentGuardian.findUniqueOrThrow({
        where: { studentId_guardianId: { studentId, guardianId: guardian.id } },
        select: { relationship: true },
      }),
      this.prisma.studentFee.findMany({
        where: { studentId, status: { in: [...OWING_STATUSES] } },
        select: { totalAmount: true, discountAmount: true, amountPaid: true },
      }),
      this.prisma.payment.aggregate({
        where: { studentId, status: PaymentStatus.PENDING },
        _sum: { amount: true },
      }),
      this.prisma.studentResult.findFirst({
        where: {
          studentId,
          resultSheet: { status: ResultSheetStatus.PUBLISHED },
        },
        orderBy: { resultSheet: { publishedAt: 'desc' } },
        include: {
          resultSheet: {
            select: {
              term: {
                select: {
                  id: true,
                  name: true,
                  session: { select: { name: true } },
                },
              },
              _count: {
                select: {
                  studentResults: { where: { position: { not: null } } },
                },
              },
            },
          },
        },
      }),
    ]);

    const middle = student.middleName ? ` ${student.middleName}` : '';
    return {
      studentId: student.id,
      admissionNumber: student.studentId,
      fullName: `${student.lastName}, ${student.firstName}${middle}`,
      gender: student.gender,
      photoUrl: student.photoUrl,
      className: student.classArm
        ? `${student.classArm.class.name} ${student.classArm.name}`
        : null,
      relationship: link.relationship,
      feeBalance: toAmount(sum(invoices.map((invoice) => balance(invoice)))),
      pendingPayments: toAmount(pending._sum.amount ?? ZERO),
      latestResult: latest ? this.resultLine(latest) : null,
    };
  }

  private resultLine(row: {
    averageScore: Prisma.Decimal;
    position: number | null;
    resultSheet: {
      term: { id: string; name: string; session: { name: string } };
      _count: { studentResults: number };
    };
  }): PortalLatestResultDto {
    return {
      termId: row.resultSheet.term.id,
      termName: row.resultSheet.term.name,
      sessionName: row.resultSheet.term.session.name,
      averageScore: toAmount(row.averageScore),
      positionLabel: row.position ? ordinal(row.position) : null,
      outOf: row.resultSheet._count.studentResults,
    };
  }
}
