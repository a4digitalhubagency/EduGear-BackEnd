import { Injectable } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { balance } from '../finance/fee-math';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';

/**
 * Everything held about one student, in a structured, commonly used,
 * machine-readable form.
 *
 * This is what sections 34(1)(b) and 38 of the NDP Act entitle a data subject
 * to: not a screenshot, not a PDF, but the data itself in a form they can
 * take elsewhere. It is also what clause 11 of the Terms promises a school on
 * the way out, one student at a time.
 *
 * Two rules shape it:
 *
 * **It is read through the tenant-guarded client.** The export is the single
 * most concentrated view of a child that exists in this application, so it
 * goes through the same isolation as everything else rather than taking the
 * `runAsSystem` shortcut that would have been easier. Another school's student
 * is not found.
 *
 * **It contains no internal identifiers beyond what the subject needs.** Row
 * ids are included for the records themselves — a portability export has to be
 * re-importable to be worth anything — but membership ids, token versions and
 * audit internals stay out. A subject access request is not a database dump.
 */
@Injectable()
export class StudentExportService {
  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  async export(studentId: string): Promise<StudentExport> {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: {
        classArm: { select: { name: true, class: { select: { name: true } } } },
        guardians: {
          include: {
            guardian: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                altPhone: true,
                addressLine: true,
                occupation: true,
              },
            },
          },
          orderBy: { isPrimary: 'desc' },
        },
        fees: {
          include: { items: true, payments: { orderBy: { paidAt: 'asc' } } },
          orderBy: { createdAt: 'asc' },
        },
        scores: {
          include: {
            component: { select: { name: true, maxScore: true } },
            subject: { select: { name: true, code: true } },
            term: { select: { name: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        studentResults: {
          include: {
            resultSheet: {
              select: {
                publishedAt: true,
                term: {
                  select: { name: true, session: { select: { name: true } } },
                },
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        subjectResults: { orderBy: { subjectName: 'asc' } },
        attendance: { orderBy: { date: 'asc' } },
      },
    });

    if (!student) throw AppException.notFound('Student');

    const school = await this.prisma.school.findFirstOrThrow({
      select: { name: true },
    });

    return {
      exportedAt: new Date().toISOString(),
      format: 'edugear.student-export.v1',
      notice:
        'Produced under sections 34(1)(b) and 38 of the Nigeria Data ' +
        'Protection Act 2023. It contains the personal data this school ' +
        'holds about the named student through EduGear.',
      school: { name: school.name },

      student: {
        id: student.id,
        admissionNumber: student.studentId,
        firstName: student.firstName,
        middleName: student.middleName,
        lastName: student.lastName,
        gender: student.gender,
        dateOfBirth: student.dateOfBirth,
        email: student.email,
        phone: student.phone,
        addressLine: student.addressLine,
        nationality: student.nationality,
        admissionDate: student.admissionDate,
        departedAt: student.departedAt,
        status: student.status,
        currentClass: student.classArm
          ? `${student.classArm.class.name} ${student.classArm.name}`
          : null,
        notes: student.notes,
        recordCreatedAt: student.createdAt,
      },

      // Called out separately rather than mixed into the record above, so a
      // parent reading their own export can see at a glance exactly which
      // special-category data is held — and ask for it to go.
      sensitiveData: {
        notice:
          'Held under consent (NDP Act s.30(1)(a)). You may withdraw that ' +
          'consent at any time and these fields will be erased, without ' +
          'affecting any other part of the record.',
        genotype: student.genotype,
        bloodGroup: student.bloodGroup,
        religion: student.religion,
        stateOfOrigin: student.stateOfOrigin,
        lga: student.lga,

        // The consent itself is part of the answer. A subject access request
        // under s.34(1)(a) asks what is held *and on what basis*, and for
        // these five fields the basis is a specific act by a specific person
        // on a specific day. Naming it is also how a parent spots a consent
        // they never gave.
        consent: student.sensitiveConsentAt
          ? {
              givenAt: student.sensitiveConsentAt.toISOString(),
              givenBy: student.sensitiveConsentBy,
              method: student.sensitiveConsentMethod,
            }
          : null,
        consentWithdrawnAt:
          student.sensitiveConsentWithdrawnAt?.toISOString() ?? null,
      },

      guardians: student.guardians.map((link) => ({
        id: link.guardian.id,
        relationship: link.relationship,
        isPrimary: link.isPrimary,
        firstName: link.guardian.firstName,
        lastName: link.guardian.lastName,
        email: link.guardian.email,
        phone: link.guardian.phone,
        altPhone: link.guardian.altPhone,
        addressLine: link.guardian.addressLine,
        occupation: link.guardian.occupation,
      })),

      finance: student.fees.map((fee) => ({
        id: fee.id,
        status: fee.status,
        totalAmount: fee.totalAmount.toString(),
        discountAmount: fee.discountAmount.toString(),
        amountPaid: fee.amountPaid.toString(),
        // Derived with the same function the application bills from, so an
        // export can never show a parent a different balance from the portal.
        balance: balance(fee).toString(),
        dueDate: fee.dueDate,
        waiverReason: fee.waiverReason,
        issuedAt: fee.createdAt,
        items: fee.items.map((item) => ({
          category: item.categoryName,
          amount: item.amount.toString(),
        })),
        payments: fee.payments.map((payment) => ({
          id: payment.id,
          receiptNumber: payment.receiptNumber,
          amount: payment.amount.toString(),
          method: payment.method,
          reference: payment.reference,
          status: payment.status,
          paidAt: payment.paidAt,
          verifiedAt: payment.verifiedAt,
          refundedAt: payment.refundedAt,
          refundReason: payment.refundReason,
        })),
      })),

      scores: student.scores.map((score) => ({
        subject: score.subject.name,
        subjectCode: score.subject.code,
        term: score.term.name,
        component: score.component.name,
        maxScore: score.component.maxScore.toString(),
        score: score.score.toString(),
        recordedAt: score.createdAt,
      })),

      results: student.studentResults.map((result) => ({
        session: result.resultSheet.term.session.name,
        term: result.resultSheet.term.name,
        totalScore: result.totalScore.toString(),
        averageScore: result.averageScore.toString(),
        position: result.position,
        subjectCount: result.subjectCount,
        formTeacherComment: result.formTeacherComment,
        principalComment: result.principalComment,
        publishedAt: result.resultSheet.publishedAt,
      })),

      subjectResults: student.subjectResults.map((result) => ({
        subject: result.subjectName,
        totalScore: result.totalScore.toString(),
        grade: result.grade,
        remark: result.remark,
        isPass: result.isPass,
        position: result.position,
        componentScores: result.componentScores,
      })),

      attendance: student.attendance.map((record) => ({
        date: record.date,
        status: record.status,
        note: record.note,
      })),
    };
  }
}

/** The export's shape. Versioned by `format`, so a consumer can check it. */
export interface StudentExport {
  exportedAt: string;
  format: 'edugear.student-export.v1';
  notice: string;
  school: { name: string };
  student: Record<string, unknown>;
  sensitiveData: Record<string, unknown>;
  guardians: Record<string, unknown>[];
  finance: Record<string, unknown>[];
  scores: Record<string, unknown>[];
  results: Record<string, unknown>[];
  subjectResults: Record<string, unknown>[];
  attendance: Record<string, unknown>[];
}
