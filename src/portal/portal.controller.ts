import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { PERMISSIONS } from '../common/constants/permissions';
import { CurrentSchool, RequirePermissions } from '../common/decorators';
import { ReceiptDto, StatementDto } from '../finance/dto/document.dto';
import { PaymentDto } from '../finance/dto/payment.dto';
import {
  NotificationDto,
  QueryNotificationsDto,
} from '../notifications/dto/notification.dto';
import { InAppNotificationsService } from '../notifications/in-app-notifications.service';
import { ReportCardDto } from '../results/dto/report-card.dto';
import {
  PortalChildDto,
  PortalMeDto,
  PortalOverviewDto,
  PortalResultTermDto,
  PortalTermQueryDto,
  SubmitPaymentDto,
} from './dto/portal.dto';
import { PortalService } from './portal.service';

/**
 * The parent portal. Every route needs portal.access — which only the Parent
 * role holds, so staff tokens are refused here — and every child-specific
 * route is further limited to the parent's own linked children.
 */
@ApiTags('Parent Portal')
@ApiBearerAuth()
@Controller('portal')
@RequirePermissions(PERMISSIONS.PORTAL_ACCESS)
export class PortalController {
  constructor(
    private readonly portal: PortalService,
    private readonly notifications: InAppNotificationsService,
    private readonly audit: AuditService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'The parent, their children and unread count' })
  @ApiOkResponse({ type: PortalMeDto })
  me(): Promise<PortalMeDto> {
    return this.portal.me();
  }

  @Get('children')
  @ApiOperation({ summary: 'My children, with fee balance and latest result' })
  @ApiOkResponse({ type: [PortalChildDto] })
  children(): Promise<PortalChildDto[]> {
    return this.portal.children();
  }

  @Get('children/:studentId')
  @ApiOperation({
    summary: 'One child: class, fees, latest result, attendance this term',
  })
  @ApiOkResponse({ type: PortalOverviewDto })
  overview(
    @Param('studentId', ParseUUIDPipe) studentId: string,
  ): Promise<PortalOverviewDto> {
    return this.portal.overview(studentId);
  }

  @Get('children/:studentId/fees')
  @ApiOperation({
    summary: 'Fee statement: invoices, payments and running balance',
  })
  @ApiOkResponse({ type: StatementDto })
  fees(
    @Param('studentId', ParseUUIDPipe) studentId: string,
  ): Promise<StatementDto> {
    return this.portal.statement(studentId);
  }

  @Get('children/:studentId/payments/:paymentId/receipt')
  @ApiOperation({ summary: 'Receipt for a verified payment' })
  @ApiOkResponse({ type: ReceiptDto })
  receipt(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<ReceiptDto> {
    return this.portal.receipt(studentId, paymentId);
  }

  @Post('children/:studentId/payments')
  @ApiOperation({
    summary: 'Send proof of a payment',
    description:
      'Arrives as PENDING and changes no balance until the bursar verifies it.',
  })
  @ApiCreatedResponse({ type: PaymentDto })
  async submitPayment(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() dto: SubmitPaymentDto,
    @CurrentSchool() schoolId: string,
  ): Promise<PaymentDto> {
    const payment = await this.portal.submitPayment(studentId, dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.PORTAL_PAYMENT_SUBMITTED,
      entityType: 'Payment',
      entityId: payment.id,
      description: `A parent submitted ₦${payment.amount} for ${payment.studentName}`,
      metadata: { method: payment.method, reference: payment.reference },
    });
    return payment;
  }

  @Get('children/:studentId/results')
  @ApiOperation({ summary: 'Terms with published results' })
  @ApiOkResponse({ type: [PortalResultTermDto] })
  results(
    @Param('studentId', ParseUUIDPipe) studentId: string,
  ): Promise<PortalResultTermDto[]> {
    return this.portal.results(studentId);
  }

  @Get('children/:studentId/results/:termId')
  @ApiOperation({ summary: 'A published report card' })
  @ApiOkResponse({ type: ReportCardDto })
  reportCard(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Param('termId', ParseUUIDPipe) termId: string,
  ): Promise<ReportCardDto> {
    return this.portal.reportCard(studentId, termId);
  }

  @Get('children/:studentId/attendance')
  @ApiOperation({ summary: 'Attendance for a term (default: the current one)' })
  attendance(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Query() query: PortalTermQueryDto,
  ) {
    return this.portal.attendanceFor(studentId, query.termId);
  }

  @Get('notifications')
  @ApiOperation({
    summary: 'My notifications, newest first, with the unread count',
  })
  notificationsList(@Query() query: QueryNotificationsDto) {
    return this.notifications.list(query);
  }

  @Post('notifications/read-all')
  @ApiOperation({ summary: 'Mark every notification read' })
  @HttpCode(HttpStatus.OK)
  readAll(): Promise<{ updated: number }> {
    return this.notifications.markAllRead();
  }

  @Post('notifications/:id/read')
  @ApiOperation({ summary: 'Mark one notification read' })
  @ApiOkResponse({ type: NotificationDto })
  @HttpCode(HttpStatus.OK)
  read(@Param('id', ParseUUIDPipe) id: string): Promise<NotificationDto> {
    return this.notifications.markRead(id);
  }
}
