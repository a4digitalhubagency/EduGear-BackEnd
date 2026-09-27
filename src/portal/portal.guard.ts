import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AccessControlService } from '../auth/access-control.service';
import { PERMISSIONS } from '../common/constants/permissions';
import { AuthContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';

/**
 * Who may open the parent portal.
 *
 * Holding `portal.access` is one way in — it is the Parent role's only
 * permission. Being a guardian at this school is the other, and it is what lets
 * a teacher who is also a parent here use the portal for their own children
 * without a second login. A membership carries one role, so the alternative
 * would be two memberships per user per school, and that ambiguity would reach
 * every query that resolves "their membership at this school".
 *
 * The consequence, accepted deliberately: a teacher-parent browses the portal on
 * a token that also carries their staff permissions. `assertWard` still confines
 * every child route to their own children, so no other family is reachable —
 * but this cannot express "while acting as a parent, you may not act as staff".
 * For the same person, holding both is the truth rather than a compromise.
 */
@Injectable()
export class PortalGuard implements CanActivate {
  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly accessControl: AccessControlService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ auth?: AuthContext }>();
    const auth = request.auth;

    // The global guards run first, so this only ever sees an authenticated
    // request with a resolved tenant.
    if (!auth) throw AppException.unauthorized();

    const snapshot = await this.accessControl.getMembershipSnapshot(
      auth.membershipId,
    );
    if (snapshot?.permissions.has(PERMISSIONS.PORTAL_ACCESS)) return true;

    // Scoped to this school by the tenant guard, so a guardian record elsewhere
    // does not open this school's portal.
    const guardian = await this.prisma.guardian.findFirst({
      where: { userId: auth.userId },
      select: { id: true },
    });
    if (guardian) return true;

    throw AppException.forbidden(
      'The parent portal is for parents of students at this school',
      ErrorCode.INSUFFICIENT_PERMISSIONS,
    );
  }
}
