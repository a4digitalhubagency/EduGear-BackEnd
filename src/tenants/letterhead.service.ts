import { Injectable } from '@nestjs/common';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';

export interface SchoolLetterhead {
  name: string;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  phone: string | null;
  email: string;
  logoUrl: string | null;
  motto: string | null;
}

/**
 * The school's printed identity — receipts, statements and report cards all
 * carry it — read for the active tenant only.
 */
@Injectable()
export class LetterheadService {
  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  async current(): Promise<SchoolLetterhead> {
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
}
