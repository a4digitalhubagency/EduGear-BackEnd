import { Module } from '@nestjs/common';
import { PlatformAdminModule } from './platform-admin.module';
import { RetentionModule } from '../retention/retention.module';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformController } from './platform.controller';
import { PlatformSchoolsService } from './platform-schools.service';
import { BreachService } from './breach.service';

/**
 * A4's operator console. Everything here runs outside a tenant, so it is kept
 * deliberately small: sign in, look at schools, change a school's status, and
 * decide who else may do so.
 */
@Module({
  imports: [PlatformAdminModule, RetentionModule],
  controllers: [PlatformController],
  providers: [PlatformAuthService, PlatformSchoolsService, BreachService],
})
export class PlatformModule {}
