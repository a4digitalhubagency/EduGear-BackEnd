import { Inject } from '@nestjs/common';

/** DI token for the tenant-guarded Prisma client. */
export const PRISMA = Symbol('PRISMA');

/** Sugar for `@Inject(PRISMA)`. */
export const InjectPrisma = () => Inject(PRISMA);
