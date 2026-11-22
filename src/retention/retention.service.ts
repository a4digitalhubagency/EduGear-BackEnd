import { Injectable, Logger } from '@nestjs/common';
import { FilePurpose, MembershipStatus, StudentStatus } from '@prisma/client';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { FilesService } from '../files/files.service';
import {
  clearFields,
  cutoffsFor,
  RetentionCutoffs,
  STUDENT_RESIDUE_FIELDS,
} from './retention-policy';
import {
  PurgeSchoolDto,
  RetentionRunDto,
  RetentionTaskResultDto,
  SchoolPurgeDto,
} from './dto/retention.dto';

interface Task {
  name: string;
  description: string;
  cutoff: (c: RetentionCutoffs) => Date;
  /** Rows this task would act on. */
  count: (c: RetentionCutoffs) => Promise<number>;
  /** Acts, returning how many rows it changed. */
  run: (c: RetentionCutoffs) => Promise<number>;
}

/**
 * Enforces `docs/legal/retention-schedule.md`.
 *
 * **Everything here is previewable.** `preview()` and `run()` share one task
 * list, so what a preview reports is what a run does — there is no second code
 * path that could disagree. That property is the reason anyone will be willing
 * to turn this on: these jobs destroy data about children, and a destructive
 * job nobody has watched in dry-run first does not deserve to be trusted.
 *
 * **Not scheduled, deliberately.** There is no cron in this application, and
 * the first thing a new scheduler would do is quietly destroy records on a
 * timer. Runs are triggered from the platform console or by
 * `npm run retention:run`, every run is audited, and nothing is due in the
 * first ninety days of a school's life anyway. Wiring this to a scheduler is
 * a deliberate second step, taken once the preview has been boring for a
 * while.
 *
 * Every task runs `runAsSystem`: this is maintenance across all tenants, and
 * the tenant guard has no school to scope to.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // The tasks
  // ---------------------------------------------------------------------------

  private tasks(): Task[] {
    return [
      {
        name: 'students.minimise',
        description:
          'Destroy contact details, notes, photo and sensitive fields of ' +
          'students who left over 90 days ago. The academic record is kept.',
        cutoff: (c) => c.studentMinimisation,
        count: (c) =>
          this.prisma.student.count({ where: this.departedWhere(c) }),
        run: (c) => this.minimiseStudents(c),
      },
      {
        name: 'guardians.minimise',
        description:
          'Destroy contact details of guardians whose last linked student ' +
          'left over 12 months ago.',
        cutoff: (c) => c.guardianContact,
        count: async (c) => (await this.staleGuardianIds(c)).length,
        run: (c) => this.minimiseGuardians(c),
      },
      {
        name: 'audit.stripNetworkData',
        description:
          'Remove IP address and browser from audit entries over 12 months ' +
          'old. The entry itself survives.',
        cutoff: (c) => c.auditNetworkData,
        count: (c) =>
          this.prisma.auditLog.count({
            where: {
              createdAt: { lt: c.auditNetworkData },
              OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }],
            },
          }),
        run: (c) => this.stripAuditNetworkData(c),
      },
      {
        name: 'accounts.deidentify',
        description:
          'De-identify accounts with no active membership, dormant over 24 ' +
          'months. The row survives so the audit trail stays attributable.',
        cutoff: (c) => c.deactivatedAccount,
        count: async (c) => (await this.dormantUserIds(c)).length,
        run: (c) => this.deidentifyDormantAccounts(c),
      },
      {
        name: 'notifications.purge',
        description: 'Delete in-app notifications over 24 months old.',
        cutoff: (c) => c.notification,
        count: (c) =>
          this.prisma.notification.count({
            where: { createdAt: { lt: c.notification } },
          }),
        run: async (c) =>
          (
            await this.prisma.notification.deleteMany({
              where: { createdAt: { lt: c.notification } },
            })
          ).count,
      },
      {
        name: 'webhookEvents.purge',
        description: 'Delete provider webhook records over 24 months old.',
        cutoff: (c) => c.webhookEvent,
        count: (c) =>
          this.prisma.webhookEvent.count({
            where: { receivedAt: { lt: c.webhookEvent } },
          }),
        run: async (c) =>
          (
            await this.prisma.webhookEvent.deleteMany({
              where: { receivedAt: { lt: c.webhookEvent } },
            })
          ).count,
      },
      {
        name: 'tokens.purge',
        description:
          'Delete refresh and verification tokens that expired over 30 days ' +
          'ago. Expiry alone stops them working; this stops us holding them.',
        cutoff: (c) => c.expiredToken,
        count: async (c) =>
          (await this.prisma.refreshToken.count({
            where: { expiresAt: { lt: c.expiredToken } },
          })) +
          (await this.prisma.verificationToken.count({
            where: { expiresAt: { lt: c.expiredToken } },
          })),
        run: async (c) => {
          const [refresh, verification] = await Promise.all([
            this.prisma.refreshToken.deleteMany({
              where: { expiresAt: { lt: c.expiredToken } },
            }),
            this.prisma.verificationToken.deleteMany({
              where: { expiresAt: { lt: c.expiredToken } },
            }),
          ]);
          return refresh.count + verification.count;
        },
      },
      {
        name: 'audit.purge',
        description: 'Delete audit entries over 7 years old.',
        cutoff: (c) => c.audit,
        count: (c) =>
          this.prisma.auditLog.count({ where: { createdAt: { lt: c.audit } } }),
        run: async (c) =>
          (
            await this.prisma.auditLog.deleteMany({
              where: { createdAt: { lt: c.audit } },
            })
          ).count,
      },
      {
        name: 'finance.purge',
        description:
          'Delete invoices and payments over 7 years old, with their ' +
          'evidence files.',
        cutoff: (c) => c.financial,
        count: (c) =>
          this.prisma.studentFee.count({
            where: { createdAt: { lt: c.financial } },
          }),
        run: (c) => this.purgeFinancial(c),
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Preview / run
  // ---------------------------------------------------------------------------

  /** Reports what a run would do. Changes nothing. */
  async preview(only?: string): Promise<RetentionRunDto> {
    return this.execute(false, only);
  }

  /** Does it, and audits each task. */
  async run(only?: string): Promise<RetentionRunDto> {
    return this.execute(true, only);
  }

  private async execute(
    executed: boolean,
    only?: string,
  ): Promise<RetentionRunDto> {
    const all = this.tasks();
    const selected = only ? all.filter((t) => t.name === only) : all;

    if (only && selected.length === 0) {
      throw AppException.badRequest(
        `Unknown retention task "${only}". Known tasks: ${all
          .map((t) => t.name)
          .join(', ')}`,
      );
    }

    // One clock for the whole run. Computing `new Date()` per task would let a
    // long run use different cutoffs for different tasks, so a preview and the
    // run that followed it could legitimately disagree.
    const runAt = new Date();
    const cutoffs = cutoffsFor(runAt);

    return RequestContext.runAsSystem(async () => {
      const results: RetentionTaskResultDto[] = [];

      for (const task of selected) {
        const base = {
          task: task.name,
          description: task.description,
          cutoff: task.cutoff(cutoffs),
        };

        try {
          const affected = executed
            ? await task.run(cutoffs)
            : await task.count(cutoffs);
          results.push({ ...base, affected, error: null });

          if (executed && affected > 0) {
            await this.audit.record({
              action: AUDIT_ACTIONS.RETENTION_TASK_RUN,
              entityType: 'Retention',
              entityId: task.name,
              description: `${task.name}: ${affected} record(s)`,
              metadata: {
                task: task.name,
                affected,
                cutoff: base.cutoff.toISOString(),
              },
            });
          }
        } catch (error) {
          // One failing task must not abandon the rest — and the failure has
          // to be visible, because a task that silently stopped running is
          // indistinguishable from one with nothing to do.
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.error(`Retention task ${task.name} failed: ${message}`);
          results.push({ ...base, affected: 0, error: message });
        }
      }

      return {
        executed,
        runAt,
        tasks: results,
        totalAffected: results.reduce((sum, r) => sum + r.affected, 0),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Task implementations
  // ---------------------------------------------------------------------------

  private departedWhere(c: RetentionCutoffs) {
    return {
      status: { in: [StudentStatus.GRADUATED, StudentStatus.WITHDRAWN] },
      departedAt: { lt: c.studentMinimisation },
      // Only those still holding something. Without this every past student
      // is "affected" on every run and the number never falls to zero, so
      // nobody can tell whether the job is working.
      OR: STUDENT_RESIDUE_FIELDS.map((field) => ({ [field]: { not: null } })),
    };
  }

  private async minimiseStudents(c: RetentionCutoffs): Promise<number> {
    const due = await this.prisma.student.findMany({
      where: this.departedWhere(c),
      select: { id: true, photoUrl: true },
    });

    for (const student of due) {
      // The stored file first. Nulling the column alone would leave the
      // photograph of a child sitting in the bucket with nothing pointing at
      // it — unreferenced, unreachable, and still there.
      if (student.photoUrl) {
        await this.files.removeLinked(FilePurpose.STUDENT_PHOTO, {
          type: 'Student',
          id: student.id,
        });
      }

      await this.prisma.student.update({
        where: { id: student.id },
        data: clearFields(STUDENT_RESIDUE_FIELDS),
      });
    }

    return due.length;
  }

  /**
   * Guardians whose last linked student left long enough ago, plus guardians
   * left with no links at all.
   *
   * The second case uses `updatedAt`, which is imprecise — it is the best
   * timestamp available once the join row is gone. It errs towards keeping
   * the data slightly longer, which is the safe direction for an imprecision.
   */
  private async staleGuardianIds(c: RetentionCutoffs): Promise<string[]> {
    // `phone` is NOT NULL in the schema, so `{ not: null }` is not a legal
    // filter for it — Prisma rejects the whole query. Blanked is what
    // "destroyed" looks like for that column, so that is what we test for.
    const holdsContactData = {
      OR: [
        { phone: { not: '' } },
        { email: { not: null } },
        { altPhone: { not: null } },
        { addressLine: { not: null } },
        { occupation: { not: null } },
      ],
    };

    const candidates = await this.prisma.guardian.findMany({
      where: {
        AND: [
          holdsContactData,
          // Nobody currently enrolled depends on this guardian.
          { students: { none: { student: { status: StudentStatus.ACTIVE } } } },
        ],
      },
      select: {
        id: true,
        updatedAt: true,
        students: { select: { student: { select: { departedAt: true } } } },
      },
    });

    return candidates
      .filter((guardian) => {
        if (guardian.students.length === 0) {
          return guardian.updatedAt < c.guardianContact;
        }
        // The most recent departure governs: a guardian with two children
        // keeps their details until the *second* one has been gone long
        // enough, not the first.
        const latest = guardian.students
          .map((link) => link.student.departedAt)
          .reduce<Date | null>(
            (newest, date) =>
              date && (!newest || date > newest) ? date : newest,
            null,
          );
        return latest !== null && latest < c.guardianContact;
      })
      .map((guardian) => guardian.id);
  }

  private async minimiseGuardians(c: RetentionCutoffs): Promise<number> {
    const ids = await this.staleGuardianIds(c);
    if (ids.length === 0) return 0;

    const result = await this.prisma.guardian.updateMany({
      where: { id: { in: ids } },
      // Not `clearFields`: `phone` is NOT NULL in the schema, because a
      // guardian without one was never useful to a school. Blanking it
      // destroys the number just as completely as a null would, without a
      // migration whose only purpose is to make this line tidier.
      data: {
        phone: '',
        email: null,
        altPhone: null,
        addressLine: null,
        occupation: null,
      },
    });
    return result.count;
  }

  private async stripAuditNetworkData(c: RetentionCutoffs): Promise<number> {
    const result = await this.prisma.auditLog.updateMany({
      where: {
        createdAt: { lt: c.auditNetworkData },
        OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }],
      },
      data: { ipAddress: null, userAgent: null },
    });
    return result.count;
  }

  /** Users with no active membership anywhere, dormant past the period. */
  private async dormantUserIds(c: RetentionCutoffs): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: {
        updatedAt: { lt: c.deactivatedAccount },
        memberships: { none: { status: MembershipStatus.ACTIVE } },
        // A platform operator's account is never swept: it belongs to no
        // school, so "no active membership" is its normal state, not dormancy.
        platformAdmin: { is: null },
        // Belt and braces. Every sign-in resolves a membership, so a user
        // with none cannot authenticate and the clause above should already
        // cover this. But a parent's login is a one-way door — de-identify it
        // and they can never get back in, and nobody will connect the lockout
        // to a sweep that ran months earlier. The exclusion costs one join.
        guardianProfiles: { none: {} },
        NOT: { email: { endsWith: DEIDENTIFIED_EMAIL_DOMAIN } },
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  private async deidentifyDormantAccounts(
    c: RetentionCutoffs,
  ): Promise<number> {
    const ids = await this.dormantUserIds(c);

    for (const id of ids) {
      await this.prisma.user.update({
        where: { id },
        data: {
          // Deterministic and unique, so the unique index on email holds and
          // a second run is a no-op rather than a collision.
          email: `deleted-${id}${DEIDENTIFIED_EMAIL_DOMAIN}`,
          firstName: 'Former',
          lastName: 'User',
          phone: null,
          avatarUrl: null,
          // Not a credential anyone can use; `.invalid` is reserved, so the
          // address can never be delivered to.
          passwordHash: '',
          // Ends every outstanding session the moment this lands.
          tokenVersion: { increment: 1 },
        },
      });
    }

    return ids.length;
  }

  /**
   * Seven-year financial purge.
   *
   * Nothing will match this for seven years, which is exactly why it is built
   * and tested now: the first time it finds rows, nobody will remember writing
   * it, and that is the worst moment to discover it deletes the wrong thing.
   */
  private async purgeFinancial(c: RetentionCutoffs): Promise<number> {
    const due = await this.prisma.studentFee.findMany({
      where: { createdAt: { lt: c.financial } },
      select: { id: true, payments: { select: { id: true } } },
    });
    if (due.length === 0) return 0;

    for (const fee of due) {
      // Evidence is linked to the payment, not the student — a bank transfer
      // slip for a seven-year-old invoice has no reason to outlive it.
      for (const payment of fee.payments) {
        await this.files.removeLinked(FilePurpose.PAYMENT_EVIDENCE, {
          type: 'Payment',
          id: payment.id,
        });
      }
    }

    // Payments and line items cascade from the invoice at the database level.
    const result = await this.prisma.studentFee.deleteMany({
      where: { id: { in: due.map((f) => f.id) } },
    });
    return result.count;
  }

  // ---------------------------------------------------------------------------
  // School purge — Terms clause 11, retention schedule §8
  // ---------------------------------------------------------------------------

  /**
   * Destroys everything belonging to one school, once its export window has
   * closed.
   *
   * Guarded by typing the school's exact name, not just its id: an id is
   * pasted, and the row above the one you meant is one click away. The name
   * has to be read off the screen and typed, which is the only check that
   * catches picking the wrong school.
   */
  async purgeSchool(
    schoolId: string,
    dto: PurgeSchoolDto,
  ): Promise<SchoolPurgeDto> {
    return RequestContext.runAsSystem(async () => {
      const school = await this.prisma.school.findUnique({
        where: { id: schoolId },
        select: { id: true, name: true },
      });
      if (!school) throw AppException.notFound('School');

      if (dto.confirmSchoolName !== school.name) {
        throw AppException.badRequest(
          'confirmSchoolName does not match this school’s name',
        );
      }

      const counts = {
        students: await this.prisma.student.count({ where: { schoolId } }),
        guardians: await this.prisma.guardian.count({ where: { schoolId } }),
        invoices: await this.prisma.studentFee.count({ where: { schoolId } }),
        payments: await this.prisma.payment.count({ where: { schoolId } }),
        files: await this.prisma.fileObject.count({ where: { schoolId } }),
        memberships: await this.prisma.membership.count({
          where: { schoolId },
        }),
        auditEntries: await this.prisma.auditLog.count({ where: { schoolId } }),
      };

      const executed = dto.execute === true;
      const purgedAt = new Date();

      if (executed) {
        // Files go through the storage layer, which deletes the row before
        // the bytes — a row pointing at nothing is recoverable noise; bytes
        // nothing points at are a school's data left in a bucket forever.
        await this.files.purgeSchoolFiles(schoolId);

        // Everything else cascades from the school.
        await this.prisma.school.delete({ where: { id: schoolId } });

        this.logger.warn(
          `School ${school.name} (${schoolId}) purged: ${JSON.stringify(counts)}`,
        );
      }

      // Audited before the row is gone would be ideal, but the audit entry
      // references the school and would cascade with it — so it is written
      // here, with schoolId left null, as a platform-level record.
      await this.audit.record({
        action: executed
          ? AUDIT_ACTIONS.RETENTION_SCHOOL_PURGED
          : AUDIT_ACTIONS.RETENTION_SCHOOL_PURGE_PREVIEWED,
        entityType: 'School',
        entityId: schoolId,
        description: executed
          ? `Purged all data for ${school.name}`
          : `Previewed purge for ${school.name}`,
        metadata: { schoolName: school.name, counts },
      });

      return {
        schoolId,
        schoolName: school.name,
        executed,
        counts,
        purgedAt,
      };
    });
  }
}

/** Reserved by RFC 2606, so a de-identified address can never be delivered to. */
const DEIDENTIFIED_EMAIL_DOMAIN = '@removed.invalid';
