import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PlatformRole } from '@prisma/client';
import type { Request } from 'express';
import { AUTH_THROTTLE, STRICT_THROTTLE } from '../common/constants/throttle';
import {
  AllowNoTenant,
  Public,
  CurrentPlatformAdmin,
  RequirePlatformRole,
} from '../common/decorators';
import { PaginatedDto } from '../common/dto/pagination.dto';
import { SessionMeta } from '../auth/token.service';
import {
  ChangePasswordDto,
  MessageDto,
  RefreshTokenDto,
} from '../auth/dto/auth.dto';
import {
  ChangeEmailDto,
  ConfirmEmailChangeDto,
  GrantPlatformAccessDto,
  PlatformAdminDto,
  PlatformLoginDto,
  PlatformSchoolDto,
  PlatformStatsDto,
  QuerySchoolsDto,
  SetStorageQuotaDto,
  SuspendSchoolDto,
} from './dto/platform.dto';
import { PlatformAdminService } from './platform-admin.service';
import {
  PlatformAuthService,
  PlatformSessionDto,
} from './platform-auth.service';
import { PlatformSchoolsService } from './platform-schools.service';
import { BreachService } from './breach.service';
import { RetentionService } from '../retention/retention.service';
import {
  PurgeSchoolDto,
  RetentionRunDto,
  RunRetentionDto,
  SchoolPurgeDto,
} from '../retention/dto/retention.dto';
import {
  BreachDto,
  QueryBreachesDto,
  RecordBreachDto,
  UpdateBreachDto,
} from './dto/breach.dto';

const ALL_ROLES = [
  PlatformRole.SUPPORT,
  PlatformRole.OPERATOR,
  PlatformRole.OWNER,
];
const CAN_CHANGE = [PlatformRole.OPERATOR, PlatformRole.OWNER];

/**
 * A4's own console. The only surface in the application that reads across
 * tenants, which is why it is small, metadata-only, and marked `@AllowNoTenant`
 * on every route — there is no school behind a platform session, ever.
 */
@ApiTags('Platform')
@Controller('platform')
@AllowNoTenant()
export class PlatformController {
  constructor(
    private readonly auth: PlatformAuthService,
    private readonly schools: PlatformSchoolsService,
    private readonly admins: PlatformAdminService,
    private readonly breaches: BreachService,
    private readonly retention: RetentionService,
  ) {}

  private meta(req: Request): SessionMeta {
    return { ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  // -------------------------------------------------------------------------
  // Sign in
  // -------------------------------------------------------------------------

  @Post('auth/login')
  @Public()
  // Tighter than a school login: far fewer accounts, so far fewer legitimate
  // attempts, and a much larger prize.
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Sign in as an A4 platform operator',
    description:
      'Separate from /auth/login: a platform account holds no membership, and ' +
      'the two doors stay separate on purpose.',
  })
  @HttpCode(HttpStatus.OK)
  login(
    @Body() dto: PlatformLoginDto,
    @Req() req: Request,
  ): Promise<PlatformSessionDto> {
    return this.auth.login(dto, this.meta(req));
  }

  @Post('auth/refresh')
  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a platform refresh token for a new pair',
    description:
      'Separate from /auth/refresh, which requires a school membership an ' +
      'operator does not have. Refresh tokens rotate on every use, and ' +
      'replaying a used one revokes the whole family. Platform access that ' +
      'has been revoked in the meantime is refused here, not at the end of ' +
      'the refresh window.',
  })
  refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
  ): Promise<PlatformSessionDto> {
    return this.auth.refresh(dto.refreshToken, this.meta(req));
  }

  @Post('auth/logout')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'End this platform session',
    description:
      'Public because it proves itself with the refresh token it revokes; an ' +
      'expired access token must not be able to strand a session open.',
  })
  @ApiOkResponse({ type: MessageDto })
  async logout(@Body() dto: RefreshTokenDto): Promise<MessageDto> {
    await this.auth.logout(dto.refreshToken);
    return { message: 'Signed out.' };
  }

  @Get('me')
  @RequirePlatformRole(...ALL_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The signed-in operator' })
  me() {
    return this.auth.me();
  }

  @Post('auth/change-password')
  @RequirePlatformRole(...ALL_ROLES)
  @ApiBearerAuth()
  // Verifies a password, so it carries the same budget as the login it guards.
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change your own platform password (revokes all sessions)',
    description:
      'The platform equivalent of /auth/change-password, which a platform ' +
      'token cannot reach: that route resolves a school membership.',
  })
  @ApiOkResponse({ type: MessageDto })
  async changePassword(@Body() dto: ChangePasswordDto): Promise<MessageDto> {
    await this.auth.changePassword(dto);
    return { message: 'Password changed. Please sign in again.' };
  }

  // -------------------------------------------------------------------------
  // Tenants
  // -------------------------------------------------------------------------

  @Post('auth/change-email')
  @RequirePlatformRole(...ALL_ROLES)
  @ApiBearerAuth()
  // Verifies a password and sends mail, so it carries the tighter budget.
  @Throttle(STRICT_THROTTLE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Ask to move this operator account to a different address',
    description:
      'Confirmation is sent to the NEW address, not the current one, so a ' +
      'mistyped address changes nothing. Nothing moves until that link is ' +
      'opened.',
  })
  @ApiAcceptedResponse({ type: MessageDto })
  async changeEmail(@Body() dto: ChangeEmailDto): Promise<MessageDto> {
    await this.auth.requestEmailChange(dto);
    return {
      message:
        'Check the new address for a confirmation link. Nothing changes until it is opened.',
    };
  }

  @Post('auth/confirm-email')
  @Public()
  @Throttle(STRICT_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm a new operator email',
    description:
      'Public because it is opened from a mailbox, which is the proof: the ' +
      'link was only ever sent to the address being moved to.',
  })
  @ApiOkResponse({ type: MessageDto })
  async confirmEmail(@Body() dto: ConfirmEmailChangeDto): Promise<MessageDto> {
    await this.auth.confirmEmailChange(dto.token);
    return { message: 'Email updated. Sign in with the new address.' };
  }

  @Get('stats')
  @RequirePlatformRole(...ALL_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Platform-wide totals' })
  @ApiOkResponse({ type: PlatformStatsDto })
  stats(): Promise<PlatformStatsDto> {
    return this.schools.stats();
  }

  @Get('schools')
  @RequirePlatformRole(...ALL_ROLES)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Every school, with status and usage',
    description:
      'Metadata only — no student, fee or result data is exposed here.',
  })
  list(
    @Query() query: QuerySchoolsDto,
  ): Promise<PaginatedDto<PlatformSchoolDto>> {
    return this.schools.list(query);
  }

  @Get('schools/:id')
  @RequirePlatformRole(...ALL_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One school: who they are and how much they use' })
  @ApiOkResponse({ type: PlatformSchoolDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<PlatformSchoolDto> {
    return this.schools.findOne(id);
  }

  @Post('schools/:id/suspend')
  @RequirePlatformRole(...CAN_CHANGE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Take a school offline',
    description:
      'Every login at that school stops working immediately. No data is deleted.',
  })
  @ApiOkResponse({ type: PlatformSchoolDto })
  @HttpCode(HttpStatus.OK)
  suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendSchoolDto,
  ): Promise<PlatformSchoolDto> {
    return this.schools.suspend(id, dto);
  }

  @Post('schools/:id/reactivate')
  @RequirePlatformRole(...CAN_CHANGE)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Put a suspended or cancelled school back online' })
  @ApiOkResponse({ type: PlatformSchoolDto })
  @HttpCode(HttpStatus.OK)
  reactivate(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PlatformSchoolDto> {
    return this.schools.reactivate(id);
  }

  @Post('schools/:id/cancel')
  @RequirePlatformRole(...CAN_CHANGE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Cancel a school',
    description:
      'A soft delete: the school is marked cancelled and its logins stop, but ' +
      'nothing is destroyed, so reactivating restores it intact.',
  })
  @ApiOkResponse({ type: PlatformSchoolDto })
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendSchoolDto,
  ): Promise<PlatformSchoolDto> {
    return this.schools.cancel(id, dto);
  }

  @Post('schools/:id/quota')
  @RequirePlatformRole(...CAN_CHANGE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Set a school's upload ceiling",
    description:
      'Megabytes, or null for the platform default. A commercial decision, so ' +
      'the school-facing settings cannot reach it.',
  })
  @ApiOkResponse({ type: PlatformSchoolDto })
  @HttpCode(HttpStatus.OK)
  setQuota(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetStorageQuotaDto,
  ): Promise<PlatformSchoolDto> {
    return this.schools.setStorageQuota(id, dto);
  }

  // -------------------------------------------------------------------------
  // Who may operate the platform
  // -------------------------------------------------------------------------

  @Get('admins')
  @RequirePlatformRole(PlatformRole.OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Platform operators' })
  @ApiOkResponse({ type: [PlatformAdminDto] })
  listAdmins(): Promise<PlatformAdminDto[]> {
    return this.admins.list();
  }

  @Post('admins')
  @RequirePlatformRole(PlatformRole.OWNER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Grant platform access to an existing user',
    description:
      'The user must belong to no school. That separation is what stops a ' +
      'compromised school login from reaching the platform.',
  })
  @ApiCreatedResponse({ type: PlatformAdminDto })
  grant(@Body() dto: GrantPlatformAccessDto): Promise<PlatformAdminDto> {
    return this.admins.grant(dto);
  }

  @Delete('admins/:id')
  @RequirePlatformRole(PlatformRole.OWNER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Revoke platform access',
    description:
      'Disables the account rather than deleting it, so what they did stays ' +
      'attributable. Their sessions stop on the next request.',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.admins.revoke(id);
  }

  // -------------------------------------------------------------------------
  // Breach register — NDP Act s.40(8)
  // -------------------------------------------------------------------------

  @Post('breaches')
  @RequirePlatformRole(PlatformRole.OPERATOR, PlatformRole.OWNER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Record a personal data breach',
    description:
      'Opens an entry in the register s.40(8) requires. The 72-hour clock in ' +
      's.40(2) runs from `discoveredAt` — when WE became aware — not from ' +
      'when the breach began. Only what GAID Art 33(5) demands up front is ' +
      'required; the rest arrives by PATCH, which is what s.40(9) means by ' +
      'providing information in phases.',
  })
  @ApiCreatedResponse({ type: BreachDto })
  recordBreach(
    @Body() dto: RecordBreachDto,
    @CurrentPlatformAdmin('platformAdminId') adminId: string,
  ): Promise<BreachDto> {
    return this.breaches.record(dto, adminId);
  }

  @Get('breaches')
  @RequirePlatformRole(...ALL_ROLES)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'The breach register',
    description:
      'Most recently discovered first. `needsAttention=true` narrows it to ' +
      'the ones whose notification decision cannot wait.',
  })
  listBreaches(
    @Query() query: QueryBreachesDto,
  ): Promise<PaginatedDto<BreachDto>> {
    return this.breaches.list(query);
  }

  @Get('breaches/:id')
  @RequirePlatformRole(...ALL_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One register entry' })
  @ApiOkResponse({ type: BreachDto })
  getBreach(@Param('id', ParseUUIDPipe) id: string): Promise<BreachDto> {
    return this.breaches.get(id);
  }

  @Patch('breaches/:id')
  @RequirePlatformRole(PlatformRole.OPERATOR, PlatformRole.OWNER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Amend a register entry',
    description:
      'There is deliberately no delete. A register that can be emptied is ' +
      'not evidence, and s.40(8) asks for a record that lets the Commission ' +
      'verify compliance — which means the awkward entries survive too.',
  })
  @ApiOkResponse({ type: BreachDto })
  updateBreach(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBreachDto,
  ): Promise<BreachDto> {
    return this.breaches.update(id, dto);
  }

  // -------------------------------------------------------------------------
  // Retention — docs/legal/retention-schedule.md
  // -------------------------------------------------------------------------

  @Post('retention/preview')
  @RequirePlatformRole(...ALL_ROLES)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'What a retention run would destroy',
    description:
      'Changes nothing. Preview and run share one task list, so what this ' +
      'reports is what a run does. Read it before running anything — these ' +
      'jobs destroy data about children.',
  })
  @ApiOkResponse({ type: RetentionRunDto })
  previewRetention(@Body() dto: RunRetentionDto): Promise<RetentionRunDto> {
    return this.retention.preview(dto.task);
  }

  @Post('retention/run')
  @RequirePlatformRole(PlatformRole.OWNER)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply the retention schedule',
    description:
      'Destructive and not reversible. OWNER only — a SUPPORT or OPERATOR ' +
      'account can preview as much as it likes, but destroying records ' +
      'across every tenant is not an operational action.',
  })
  @ApiOkResponse({ type: RetentionRunDto })
  runRetention(@Body() dto: RunRetentionDto): Promise<RetentionRunDto> {
    return this.retention.run(dto.task);
  }

  @Post('schools/:id/purge')
  @RequirePlatformRole(PlatformRole.OWNER)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Destroy every record belonging to one school',
    description:
      'For a school that has left and whose 90-day export window has closed ' +
      '(Terms clause 11). Requires the school’s exact name typed back, ' +
      'because an id is pasted and the row above the one you meant is one ' +
      'click away. Defaults to a preview: pass execute=true to do it.',
  })
  @ApiOkResponse({ type: SchoolPurgeDto })
  purgeSchool(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PurgeSchoolDto,
  ): Promise<SchoolPurgeDto> {
    return this.retention.purgeSchool(id, dto);
  }
}
