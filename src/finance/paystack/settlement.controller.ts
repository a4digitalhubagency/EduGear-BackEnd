import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PERMISSIONS } from '../../common/constants/permissions';
import { CurrentSchool, RequirePermissions } from '../../common/decorators';
import {
  BankDto,
  ResolveAccountDto,
  ResolvedAccountDto,
  SettlementAccountDto,
  SetSettlementAccountDto,
} from './dto/settlement.dto';
import { SettlementService } from './settlement.service';

/**
 * Where a school's online fees are paid out to.
 *
 * Behind `school.update` — the same permission as the rest of a school's
 * settings, which in practice means the proprietor. It is not a finance
 * permission: a bursar records payments, but deciding which bank account the
 * school's money lands in is not a bookkeeping act.
 */
@ApiTags('Finance')
@ApiBearerAuth()
@Controller('finance/settlement')
export class SettlementController {
  constructor(private readonly settlement: SettlementService) {}

  @Get('banks')
  @RequirePermissions(PERMISSIONS.SCHOOL_UPDATE)
  @ApiOperation({ summary: 'Banks Paystack can settle to' })
  @ApiOkResponse({ type: BankDto, isArray: true })
  banks(): Promise<BankDto[]> {
    return this.settlement.banks();
  }

  @Put('resolve')
  @RequirePermissions(PERMISSIONS.SCHOOL_UPDATE)
  @ApiOperation({
    summary: 'Ask the bank who owns an account, before saving it',
    description:
      'Changes nothing. Show the returned name back to the user to confirm, ' +
      'so a transposed digit is caught here rather than by whoever would ' +
      'otherwise receive the fees.',
  })
  @ApiOkResponse({ type: ResolvedAccountDto })
  resolve(@Body() dto: ResolveAccountDto): Promise<ResolvedAccountDto> {
    return this.settlement.resolve(dto);
  }

  @Get()
  @RequirePermissions(PERMISSIONS.SCHOOL_UPDATE)
  @ApiOperation({ summary: 'The account fees currently settle to' })
  @ApiOkResponse({ type: SettlementAccountDto })
  current(): Promise<SettlementAccountDto> {
    return this.settlement.current();
  }

  @Put()
  @RequirePermissions(PERMISSIONS.SCHOOL_UPDATE)
  @ApiOperation({
    summary: 'Set the bank account this school is paid out to',
    description:
      'Money settles here directly; EduGear never holds it. Until this is ' +
      'set, online payments are refused rather than settled anywhere else.',
  })
  @ApiOkResponse({ type: SettlementAccountDto })
  set(
    @Body() dto: SetSettlementAccountDto,
    @CurrentSchool() schoolId: string,
  ): Promise<SettlementAccountDto> {
    return this.settlement.set(dto, schoolId);
  }
}
