import { Injectable } from '@nestjs/common';
import { AccessControlService } from '../auth/access-control.service';
import { PERMISSIONS } from '../common/constants/permissions';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';

export interface ResultsActor {
  membershipId: string;
  /** Holds results.publish: a principal or proprietor, who may act on any class. */
  isHead: boolean;
}

/**
 * Who may touch which results, beyond what a permission alone says.
 *
 * Every teacher holds results.create and results.update, so the permission
 * check lets any teacher reach any class. That is not how a school works: a
 * subject's scores belong to the teacher assigned to it, and a class's sheet to
 * its form teacher. Holders of results.publish — heads — may act anywhere,
 * because someone has to cover an absent teacher.
 */
@Injectable()
export class ResultsAccessService {
  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly accessControl: AccessControlService,
  ) {}

  async actor(): Promise<ResultsActor> {
    const auth = RequestContext.getAuth();
    if (!auth) throw AppException.unauthorized();

    const snapshot = await this.accessControl.getMembershipSnapshot(
      auth.membershipId,
    );
    return {
      membershipId: auth.membershipId,
      isHead: snapshot?.permissions.has(PERMISSIONS.RESULTS_PUBLISH) ?? false,
    };
  }

  /** Only the assigned subject teacher, or a head. */
  async assertCanEnterScores(
    classArmId: string,
    subjectId: string,
    label: string,
  ): Promise<ResultsActor> {
    const actor = await this.actor();
    if (actor.isHead) return actor;

    const assignment = await this.prisma.teachingAssignment.findUnique({
      where: { classArmId_subjectId: { classArmId, subjectId } },
      select: { teacherMembershipId: true },
    });

    if (assignment?.teacherMembershipId !== actor.membershipId) {
      throw AppException.forbidden(
        assignment
          ? `Only the teacher assigned to ${label} can enter its scores`
          : `No teacher is assigned to ${label} yet. Ask the principal to assign one.`,
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    return actor;
  }

  /** Only the arm's form teacher, or a head. */
  async assertFormTeacherOrHead(
    classArmId: string,
    label: string,
  ): Promise<ResultsActor> {
    const actor = await this.actor();
    if (actor.isHead) return actor;

    const arm = await this.prisma.classArm.findUnique({
      where: { id: classArmId },
      select: { formTeacherId: true },
    });

    if (arm?.formTeacherId !== actor.membershipId) {
      throw AppException.forbidden(
        `Only the form teacher of ${label} can do this`,
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    return actor;
  }

  async assertHead(action: string): Promise<ResultsActor> {
    const actor = await this.actor();
    if (!actor.isHead) {
      throw AppException.forbidden(
        `Only the principal can ${action}`,
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }
    return actor;
  }
}
