import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { PERMISSIONS } from '../common/constants/permissions';
import { RequirePermissions } from '../common/decorators';
import { PaginatedDto } from '../common/dto/pagination.dto';
import {
  CollectionReportDto,
  DebtorDto,
  DebtorQueryDto,
  FinanceReportQueryDto,
  SendRemindersDto,
  SendRemindersResultDto,
} from './dto/report.dto';
import { FinanceReportsService } from './finance-reports.service';
import { PaymentRemindersService } from './payment-reminders.service';

@ApiTags('Finance')
@ApiBearerAuth()
@Controller('finance')
export class FinanceReportsController {
  constructor(
    private readonly reports: FinanceReportsService,
    private readonly reminders: PaymentRemindersService,
    private readonly audit: AuditService,
  ) {}

  @Get('reports/summary')
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  @ApiOperation({
    summary: 'Billed, collected and outstanding, with a method breakdown',
  })
  @ApiOkResponse({ type: CollectionReportDto })
  summary(@Query() query: FinanceReportQueryDto): Promise<CollectionReportDto> {
    return this.reports.summary(query);
  }

  @Get('reports/debtors')
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  @ApiOperation({
    summary: 'Students who still owe, largest debt first',
    description:
      'One row per student, aggregating every invoice they have outstanding.',
  })
  debtors(@Query() query: DebtorQueryDto): Promise<PaginatedDto<DebtorDto>> {
    return this.reports.debtors(query);
  }

  @Post('reminders')
  @RequirePermissions(PERMISSIONS.FINANCE_UPDATE)
  @ApiOperation({
    summary: 'Email fee reminders to debtors’ guardians',
    description:
      'Pass dryRun to see exactly who would be contacted without sending anything.',
  })
  @ApiOkResponse({ type: SendRemindersResultDto })
  @HttpCode(HttpStatus.OK)
  async remind(@Body() dto: SendRemindersDto): Promise<SendRemindersResultDto> {
    const result = await this.reminders.send(dto);

    // A dry run contacts nobody, so it is not an auditable event.
    if (!result.dryRun) {
      await this.audit.record({
        action: AUDIT_ACTIONS.PAYMENT_REMINDERS_SENT,
        entityType: 'School',
        description: `Sent ${result.sent} fee reminder(s) to ${result.debtors} debtor(s)`,
        metadata: {
          debtors: result.debtors,
          sent: result.sent,
          skippedNoEmail: result.skippedNoEmail,
        },
      });
    }

    return result;
  }
}
