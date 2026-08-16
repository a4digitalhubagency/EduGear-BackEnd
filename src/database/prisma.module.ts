import { Global, Module } from '@nestjs/common';
import { PRISMA } from './prisma.tokens';
import { extendWithTenantGuard, PrismaService } from './prisma.service';

/**
 * Only the guarded client leaves this module. `PrismaService` (raw) stays
 * private so no feature module can inject an unscoped client.
 */
@Global()
@Module({
  providers: [
    PrismaService,
    {
      provide: PRISMA,
      useFactory: (prisma: PrismaService) => extendWithTenantGuard(prisma),
      inject: [PrismaService],
    },
  ],
  exports: [PRISMA],
})
export class PrismaModule {}
