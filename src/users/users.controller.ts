import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PERMISSIONS } from '../common/constants/permissions';
import { AuthContext } from '../common/context/request-context';
import { CurrentUser, Public, RequirePermissions } from '../common/decorators';
import { PaginatedDto } from '../common/dto/pagination.dto';
import { MessageDto } from '../auth/dto/auth.dto';
import {
  AcceptInvitationDto,
  InviteUserDto,
  QueryUsersDto,
  StaffMemberDto,
  UpdateMembershipDto,
} from './dto/user.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.USERS_READ)
  @ApiOperation({ summary: 'List staff accounts in the current school' })
  @ApiOkResponse({ description: 'Paginated staff list' })
  list(@Query() query: QueryUsersDto): Promise<PaginatedDto<StaffMemberDto>> {
    return this.users.list(query);
  }

  @Post('invite')
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.USERS_CREATE)
  @ApiOperation({
    summary: 'Invite a staff member to the current school',
    description:
      'Reuses an existing EduGear account when the email is already registered, so one person can work at several schools.',
  })
  @ApiCreatedResponse({ type: StaffMemberDto })
  @ApiForbiddenResponse({ description: 'Missing users.create permission' })
  invite(
    @Body() dto: InviteUserDto,
    @CurrentUser() auth: AuthContext,
  ): Promise<StaffMemberDto> {
    return this.users.invite(dto, auth);
  }

  @Post('accept-invitation')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a staff invitation and set a password' })
  @ApiOkResponse({ type: MessageDto })
  async acceptInvitation(
    @Body() dto: AcceptInvitationDto,
  ): Promise<MessageDto> {
    await this.users.acceptInvitation(dto);
    return { message: 'Invitation accepted. You can now sign in.' };
  }

  @Get(':membershipId')
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.USERS_READ)
  @ApiOperation({ summary: 'Get one staff account' })
  @ApiOkResponse({ type: StaffMemberDto })
  findOne(
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
  ): Promise<StaffMemberDto> {
    return this.users.findOne(membershipId);
  }

  @Patch(':membershipId')
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.USERS_UPDATE)
  @ApiOperation({
    summary: 'Update a staff member’s role, status or staff number',
  })
  @ApiOkResponse({ type: StaffMemberDto })
  update(
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: UpdateMembershipDto,
    @CurrentUser() auth: AuthContext,
  ): Promise<StaffMemberDto> {
    return this.users.update(membershipId, dto, auth);
  }

  @Delete(':membershipId')
  @ApiBearerAuth()
  @RequirePermissions(PERMISSIONS.USERS_DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke a staff member’s access to this school',
    description:
      'The person’s global EduGear account is kept; only school access is revoked.',
  })
  @ApiOkResponse({ type: MessageDto })
  async revoke(
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @CurrentUser() auth: AuthContext,
  ): Promise<MessageDto> {
    await this.users.revokeAccess(membershipId, auth);
    return { message: 'Access revoked' };
  }
}
