import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PERMISSIONS } from '../common/constants/permissions';
import { RequirePermissions } from '../common/decorators';
import {
  ReceiptDto,
  StatementDto,
  StatementQueryDto,
} from './dto/document.dto';
import { FinanceDocumentsService } from './finance-documents.service';

@ApiTags('Finance')
@ApiBearerAuth()
@Controller('finance')
export class FinanceDocumentsController {
  constructor(private readonly documents: FinanceDocumentsService) {}

  @Get('payments/:id/receipt')
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  @ApiOperation({
    summary: 'Printable receipt for a verified payment',
    description:
      'Shows the balance as it stood when this payment cleared, so a reprint never changes.',
  })
  @ApiOkResponse({ type: ReceiptDto })
  receipt(@Param('id', ParseUUIDPipe) id: string): Promise<ReceiptDto> {
    return this.documents.receipt(id);
  }

  @Get('students/:studentId/statement')
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  @ApiOperation({
    summary: 'Fee statement with a running-balance ledger',
  })
  @ApiOkResponse({ type: StatementDto })
  statement(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Query() query: StatementQueryDto,
  ): Promise<StatementDto> {
    return this.documents.statement(studentId, query);
  }
}
