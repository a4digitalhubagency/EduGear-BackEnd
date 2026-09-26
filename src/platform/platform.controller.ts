import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PlatformRole } from '@prisma/client';
import type { Request } from 'express';
import { AUTH_THROTTLE } from '../common/constants/throttle';
import {
  AllowNoTenant,
  Public,
  RequirePlatformRole,
} from '../common/decorators';
import { PaginatedDto } from '../common/dto/pagination.dto';
import { SessionMeta } from '../auth/token.service';
import {
  GrantPlatformAccessDto,
  PlatformAdminDto,
  PlatformLoginDto,
  PlatformSchoolDto,
  PlatformStatsDto,
  QuerySchoolsDto,
  SuspendSchoolDto,
} from './dto/platform.dto';
import { PlatformAdminService } from './platform-admin.service';
import {
  PlatformAuthService,
  PlatformSessionDto,
} from './platform-auth.service';
import { PlatformSchoolsService } from './platform-schools.service';

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

  @Get('me')
  @RequirePlatformRole(...ALL_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The signed-in operator' })
  me() {
    return this.auth.me();
  }

  // -------------------------------------------------------------------------
  // Tenants
  // -------------------------------------------------------------------------

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
}
