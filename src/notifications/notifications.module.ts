import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { InAppNotificationsService } from './in-app-notifications.service';

@Global()
@Module({
  providers: [EmailService, InAppNotificationsService],
  exports: [EmailService, InAppNotificationsService],
})
export class NotificationsModule {}
