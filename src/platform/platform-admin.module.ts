import { Module } from '@nestjs/common';
import { PlatformAdminService } from './platform-admin.service';

/**
 * Split out from PlatformModule on purpose: the JWT strategy needs this lookup,
 * and PlatformModule needs the auth module's services. Keeping the authority
 * lookup in a module of its own breaks what would otherwise be a cycle.
 */
@Module({
  providers: [PlatformAdminService],
  exports: [PlatformAdminService],
})
export class PlatformAdminModule {}
