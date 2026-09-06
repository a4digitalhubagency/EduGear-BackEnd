import { Injectable, Logger } from '@nestjs/common';
import { RequestContext } from '../common/context/request-context';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { EmailService } from '../notifications/email.service';
import {
  ReminderRecipientDto,
  SendRemindersDto,
  SendRemindersResultDto,
} from './dto/report.dto';
import { FinanceReportsService } from './finance-reports.service';

/**
 * Fee reminders to guardians.
 *
 * A reminder goes to every guardian of a debtor who has an email address — a
 * school cannot know which parent handles fees, and sending to one who does not
 * is far cheaper than missing the one who does. Students with no reachable
 * guardian are counted and reported rather than silently dropped, because that
 * gap is exactly what a bursar needs to know about.
 */
@Injectable()
export class PaymentRemindersService {
  private readonly logger = new Logger(PaymentRemindersService.name);

  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly reports: FinanceReportsService,
    private readonly email: EmailService,
  ) {}

  async send(dto: SendRemindersDto): Promise<SendRemindersResultDto> {
    const invoices = await this.reports.owingInvoices(dto);
    const debtors = [...this.reports.groupByStudent(invoices).values()].filter(
      (debtor) => debtor.totalOwed >= (dto.minBalance ?? 0),
    );

    const schoolName = await this.schoolName();
    const contacts = this.buildContacts(invoices, debtors);

    const recipients: ReminderRecipientDto[] = [];
    let skippedNoEmail = 0;

    for (const debtor of debtors) {
      const guardians = contacts.get(debtor.studentId) ?? [];
      if (guardians.length === 0) {
        skippedNoEmail++;
        continue;
      }

      for (const guardian of guardians) {
        recipients.push({
          studentName: debtor.studentName,
          guardianName: guardian.name,
          email: guardian.email,
          amountOwed: debtor.totalOwed,
        });

        if (dto.dryRun) continue;

        // Delivery must never fail the request: the send itself already
        // swallows provider errors, and a reminder is not a transaction.
        await this.email.send(
          this.buildMessage({
            to: guardian.email,
            guardianName: guardian.name,
            studentName: debtor.studentName,
            amountOwed: debtor.totalOwed,
            dueDate: debtor.earliestDueDate,
            schoolName,
            note: dto.message,
          }),
        );
      }
    }

    if (!dto.dryRun && recipients.length > 0) {
      this.logger.log(
        `Sent ${recipients.length} fee reminder(s) for ${debtors.length} debtor(s)`,
      );
    }

    return {
      debtors: debtors.length,
      sent: recipients.length,
      skippedNoEmail,
      dryRun: dto.dryRun ?? false,
      recipients,
    };
  }

  private buildContacts(
    invoices: Awaited<ReturnType<FinanceReportsService['owingInvoices']>>,
    debtors: { studentId: string }[],
  ): Map<string, { name: string; email: string }[]> {
    const wanted = new Set(debtors.map((debtor) => debtor.studentId));
    const contacts = new Map<string, { name: string; email: string }[]>();

    for (const invoice of invoices) {
      const student = invoice.student;
      if (!wanted.has(student.id) || contacts.has(student.id)) continue;

      contacts.set(
        student.id,
        student.guardians
          .filter((link) => Boolean(link.guardian.email))
          .map((link) => ({
            name: `${link.guardian.firstName} ${link.guardian.lastName}`,
            email: link.guardian.email as string,
          })),
      );
    }

    return contacts;
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

  private buildMessage(params: {
    to: string;
    guardianName: string;
    studentName: string;
    amountOwed: number;
    dueDate: Date | null;
    schoolName: string;
    note?: string;
  }) {
    const amount = params.amountOwed.toLocaleString('en-NG', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const due = params.dueDate
      ? ` It was due on ${params.dueDate.toISOString().slice(0, 10)}.`
      : '';
    const note = params.note ? `\n\n${params.note}` : '';

    const text =
      `Dear ${params.guardianName},\n\n` +
      `Our records show an outstanding balance of NGN ${amount} on the school ` +
      `fees for ${params.studentName}.${due}\n\n` +
      `If you have already paid, please disregard this message or send your ` +
      `payment reference to the school office so we can confirm it.${note}\n\n` +
      `${params.schoolName}`;

    return {
      to: params.to,
      subject: `Outstanding school fees for ${params.studentName}`,
      text,
      html: `<p>${text.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br />')}</p>`,
    };
  }
}
