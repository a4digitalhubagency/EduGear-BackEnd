import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  NotificationType,
  PaymentStatus,
  Prisma,
  ReminderStatus,
} from '@prisma/client';
import { RequestContext } from '../common/context/request-context';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { EmailMessage, EmailService } from '../notifications/email.service';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import {
  ReminderChildDto,
  ReminderHistoryDto,
  ReminderHistoryQueryDto,
  ReminderRecipientDto,
  SendRemindersDto,
  SendRemindersResultDto,
  SkippedDebtorDto,
  UnreachableDebtorDto,
} from './dto/report.dto';
import { ZERO, balance, sum, toAmount } from './fee-math';
import { FinanceReportsService, OwingInvoice } from './finance-reports.service';
import { naira } from './naira';

const DEFAULT_COOLDOWN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Debtor {
  studentId: string;
  studentName: string;
  admissionNumber: string;
  className: string | null;
  owed: Prisma.Decimal;
  dueDate: Date | null;
  guardians: OwingInvoice['student']['guardians'];
}

/**
 * Fee reminders by email.
 *
 * Built around what makes reminders tolerable to the parents receiving them:
 *
 *  - One email per parent, listing every child they owe for — not one email
 *    per child. A family with three children gets one message.
 *  - Money awaiting verification is not chased. A parent who has paid and is
 *    waiting for the bursar to confirm it is exactly the parent who complains.
 *  - A cooldown, enforced from the reminder log, so a second click does not
 *    mail every parent twice in an afternoon.
 *
 * Every guardian with an email is contacted: a school cannot know which parent
 * handles fees, and mailing one who does not is cheaper than missing the one
 * who does. Students with nobody reachable are returned with their phone
 * numbers, because that list is the bursar's next job.
 */
@Injectable()
export class PaymentRemindersService {
  private readonly logger = new Logger(PaymentRemindersService.name);

  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly reports: FinanceReportsService,
    private readonly email: EmailService,
    private readonly notifications: InAppNotificationsService,
  ) {}

  async send(dto: SendRemindersDto): Promise<SendRemindersResultDto> {
    const invoices = await this.reports.owingInvoices(dto);
    const pending = await this.pendingByInvoice(invoices.map((i) => i.id));
    const debtors = this.collectDebtors(invoices, pending);

    const skipped: SkippedDebtorDto[] = [];
    const minBalance = new Prisma.Decimal(dto.minBalance ?? 0);
    let eligible: Debtor[] = [];

    for (const debtor of debtors.values()) {
      if (debtor.owed.lte(0)) {
        skipped.push({
          studentId: debtor.studentId,
          studentName: debtor.studentName,
          reason: 'PAYMENT_PENDING',
          detail: 'A payment covering the balance is awaiting verification',
        });
        continue;
      }
      if (debtor.owed.lt(minBalance)) continue;
      eligible.push(debtor);
    }

    eligible = await this.applyCooldown(
      eligible,
      dto.cooldownDays ?? DEFAULT_COOLDOWN_DAYS,
      skipped,
    );

    const { recipients, unreachable } = this.groupByGuardian(eligible);

    if (dto.dryRun) {
      return this.result(
        null,
        true,
        debtors.size,
        recipients,
        unreachable,
        skipped,
      );
    }

    const batchId = randomUUID();
    if (recipients.length > 0) {
      await this.deliver(batchId, recipients, dto.message);
    }

    // Every reminded debtor — emailed or not — also lands in the portal inbox
    // of any parent with a login, so the message is there when they log in.
    await this.notifications.notifyParentsOf(
      eligible.map((debtor) => ({
        studentId: debtor.studentId,
        draft: {
          type: NotificationType.FEE_REMINDER,
          title: 'School fees outstanding',
          body: `${naira(toAmount(debtor.owed))} is outstanding for ${debtor.studentName}.`,
          data: { batchId },
        },
      })),
    );

    return this.result(
      batchId,
      false,
      debtors.size,
      recipients,
      unreachable,
      skipped,
    );
  }

  async history(
    query: ReminderHistoryQueryDto,
  ): Promise<PaginatedDto<ReminderHistoryDto>> {
    const where: Prisma.FeeReminderWhereInput = {
      ...(query.studentId ? { studentId: query.studentId } : {}),
      ...(query.batchId ? { batchId: query.batchId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.feeReminder.findMany({
        where,
        orderBy: { createdAt: query.sortOrder },
        skip: query.skip,
        take: query.limit,
        include: {
          student: {
            select: { studentId: true, firstName: true, lastName: true },
          },
        },
      }),
      this.prisma.feeReminder.count({ where }),
    ]);

    return paginate(
      rows.map((row) => ({
        id: row.id,
        batchId: row.batchId,
        studentId: row.studentId,
        studentName: `${row.student.lastName}, ${row.student.firstName}`,
        admissionNumber: row.student.studentId,
        email: row.email,
        amountOwed: toAmount(row.amountOwed),
        status: row.status,
        sentAt: row.createdAt,
      })),
      total,
      query.page,
      query.limit,
    );
  }

  // ---------------------------------------------------------------------------

  private async pendingByInvoice(
    invoiceIds: string[],
  ): Promise<Map<string, Prisma.Decimal>> {
    if (invoiceIds.length === 0) return new Map();

    const rows = await this.prisma.payment.groupBy({
      by: ['studentFeeId'],
      where: {
        studentFeeId: { in: invoiceIds },
        status: PaymentStatus.PENDING,
      },
      _sum: { amount: true },
    });

    return new Map(
      rows.map((row) => [row.studentFeeId, row._sum.amount ?? ZERO]),
    );
  }

  /** One entry per student: what they owe across invoices, less money in transit. */
  private collectDebtors(
    invoices: OwingInvoice[],
    pending: Map<string, Prisma.Decimal>,
  ): Map<string, Debtor> {
    const debtors = new Map<string, Debtor>();

    for (const invoice of invoices) {
      const outstanding = balance(invoice);
      if (outstanding.isZero()) continue;

      const owed = outstanding.sub(pending.get(invoice.id) ?? ZERO);
      const student = invoice.student;
      const existing = debtors.get(student.id);

      if (existing) {
        existing.owed = existing.owed.add(owed);
        if (
          invoice.dueDate &&
          (!existing.dueDate || invoice.dueDate < existing.dueDate)
        ) {
          existing.dueDate = invoice.dueDate;
        }
        continue;
      }

      const arm = student.classArm;
      debtors.set(student.id, {
        studentId: student.id,
        studentName: `${student.lastName}, ${student.firstName}`,
        admissionNumber: student.studentId,
        className: arm ? `${arm.class.name} ${arm.name}` : null,
        owed,
        dueDate: invoice.dueDate,
        guardians: student.guardians,
      });
    }

    return debtors;
  }

  private async applyCooldown(
    debtors: Debtor[],
    cooldownDays: number,
    skipped: SkippedDebtorDto[],
  ): Promise<Debtor[]> {
    if (cooldownDays === 0 || debtors.length === 0) return debtors;

    const since = new Date(Date.now() - cooldownDays * DAY_MS);
    const recent = await this.prisma.feeReminder.groupBy({
      by: ['studentId'],
      where: {
        studentId: { in: debtors.map((debtor) => debtor.studentId) },
        status: ReminderStatus.SENT,
        createdAt: { gte: since },
      },
      _max: { createdAt: true },
    });
    const lastSent = new Map(
      recent.map((row) => [row.studentId, row._max.createdAt]),
    );

    return debtors.filter((debtor) => {
      const last = lastSent.get(debtor.studentId);
      if (!last) return true;
      skipped.push({
        studentId: debtor.studentId,
        studentName: debtor.studentName,
        reason: 'RECENTLY_REMINDED',
        detail: `Already reminded on ${last.toISOString().slice(0, 10)}; the cooldown is ${cooldownDays} day(s)`,
      });
      return false;
    });
  }

  private groupByGuardian(debtors: Debtor[]): {
    recipients: (ReminderRecipientDto & {
      guardianId: string;
      owedByStudent: Map<string, Prisma.Decimal>;
    })[];
    unreachable: UnreachableDebtorDto[];
  } {
    const byGuardian = new Map<
      string,
      ReminderRecipientDto & {
        guardianId: string;
        owedByStudent: Map<string, Prisma.Decimal>;
      }
    >();
    const unreachable: UnreachableDebtorDto[] = [];

    for (const debtor of debtors) {
      const reachable = debtor.guardians.filter((link) => link.guardian.email);

      if (reachable.length === 0) {
        unreachable.push({
          studentId: debtor.studentId,
          studentName: debtor.studentName,
          admissionNumber: debtor.admissionNumber,
          className: debtor.className,
          amountOwed: toAmount(debtor.owed),
          guardianPhones: debtor.guardians.map((link) => link.guardian.phone),
        });
        continue;
      }

      const child: ReminderChildDto = {
        studentId: debtor.studentId,
        studentName: debtor.studentName,
        admissionNumber: debtor.admissionNumber,
        className: debtor.className,
        amountOwed: toAmount(debtor.owed),
        dueDate: debtor.dueDate,
      };

      for (const link of reachable) {
        const guardian = link.guardian;
        const entry = byGuardian.get(guardian.id) ?? {
          guardianId: guardian.id,
          guardianName: `${guardian.firstName} ${guardian.lastName}`,
          email: guardian.email!,
          children: [],
          totalOwed: 0,
          delivered: null,
          owedByStudent: new Map<string, Prisma.Decimal>(),
        };
        entry.children.push(child);
        entry.owedByStudent.set(debtor.studentId, debtor.owed);
        entry.totalOwed = toAmount(sum([...entry.owedByStudent.values()]));
        byGuardian.set(guardian.id, entry);
      }
    }

    return { recipients: [...byGuardian.values()], unreachable };
  }

  private async deliver(
    batchId: string,
    recipients: (ReminderRecipientDto & {
      guardianId: string;
      owedByStudent: Map<string, Prisma.Decimal>;
    })[],
    note?: string,
  ): Promise<void> {
    const schoolName = await this.schoolName();
    const messages = recipients.map((recipient) =>
      this.buildMessage(recipient, schoolName, note),
    );

    const accepted = await this.email.sendBatch(messages, batchId);
    recipients.forEach(
      (recipient, index) => (recipient.delivered = accepted[index]),
    );

    const membershipId = RequestContext.getAuth()?.membershipId ?? null;
    const schoolId = RequestContext.getTenantId()!;

    // Failures are logged too: the history should say "we tried", and a failed
    // send must not count toward the cooldown, which reads SENT only.
    await this.prisma.feeReminder.createMany({
      data: recipients.flatMap((recipient) =>
        [...recipient.owedByStudent.entries()].map(([studentId, owed]) => ({
          schoolId,
          batchId,
          studentId,
          guardianId: recipient.guardianId,
          email: recipient.email,
          amountOwed: owed,
          status: recipient.delivered
            ? ReminderStatus.SENT
            : ReminderStatus.FAILED,
          sentByMembershipId: membershipId,
        })),
      ),
    });

    const failed = recipients.filter(
      (recipient) => !recipient.delivered,
    ).length;
    this.logger.log(
      `Fee reminder batch ${batchId}: ${recipients.length - failed} sent, ${failed} failed`,
    );
  }

  private result(
    batchId: string | null,
    dryRun: boolean,
    debtors: number,
    recipients: ReminderRecipientDto[],
    unreachable: UnreachableDebtorDto[],
    skipped: SkippedDebtorDto[],
  ): SendRemindersResultDto {
    const reminded = new Set(
      recipients.flatMap((recipient) =>
        recipient.children.map((child) => child.studentId),
      ),
    );

    return {
      batchId,
      dryRun,
      debtors,
      sent: dryRun
        ? recipients.length
        : recipients.filter((recipient) => recipient.delivered).length,
      failed: dryRun
        ? 0
        : recipients.filter((recipient) => recipient.delivered === false)
            .length,
      studentsReminded: reminded.size,
      skippedNoEmail: unreachable.length,
      // The internal bookkeeping fields stay internal.
      recipients: recipients.map(
        ({ guardianName, email, children, totalOwed, delivered }) => ({
          guardianName,
          email,
          children,
          totalOwed,
          delivered,
        }),
      ),
      unreachable,
      skipped,
    };
  }

  private async schoolName(): Promise<string> {
    const schoolId = RequestContext.getTenantId();
    if (!schoolId) return 'Your school';

    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { name: true },
    });
    return school?.name ?? 'Your school';
  }

  private buildMessage(
    recipient: ReminderRecipientDto,
    schoolName: string,
    note?: string,
  ): EmailMessage {
    const naira = (amount: number) =>
      `NGN ${amount.toLocaleString('en-NG', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;

    const lines = recipient.children.map((child) => {
      const klass = child.className ? ` (${child.className})` : '';
      const due = child.dueDate
        ? `, due ${child.dueDate.toISOString().slice(0, 10)}`
        : '';
      return `- ${child.studentName}${klass}: ${naira(child.amountOwed)}${due}`;
    });

    const several = recipient.children.length > 1;
    const text = [
      `Dear ${recipient.guardianName},`,
      '',
      `Our records show outstanding school fees for ${several ? 'your children' : 'your child'}:`,
      '',
      ...lines,
      ...(several
        ? ['', `Total outstanding: ${naira(recipient.totalOwed)}`]
        : []),
      '',
      'If you have already paid, please send your payment reference to the school office so we can confirm it — no further action is needed once it is verified.',
      ...(note ? ['', note] : []),
      '',
      schoolName,
    ].join('\n');

    const escape = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return {
      to: recipient.email,
      subject: several
        ? `Outstanding school fees for your children — ${schoolName}`
        : `Outstanding school fees for ${recipient.children[0].studentName} — ${schoolName}`,
      text,
      html: `<p>${escape(text).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br />')}</p>`,
    };
  }
}
