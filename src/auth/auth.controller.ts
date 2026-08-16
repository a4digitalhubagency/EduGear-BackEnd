import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AllowNoTenant, CurrentUser, Public } from '../common/decorators';
import { AUTH_THROTTLE, STRICT_THROTTLE } from '../common/constants/throttle';
import { AuthContext } from '../common/context/request-context';
import { AuthService } from './auth.service';
import { SessionMeta } from './token.service';
import {
  AuthTokensDto,
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  MessageDto,
  ProfileDto,
  RefreshTokenDto,
  RegisterSchoolDto,
  ResendVerificationDto,
  ResetPasswordDto,
  SessionDto,
  TokenDto,
} from './dto/auth.dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private meta(req: Request): SessionMeta {
    return { ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  @Post('register-school')
  @Public()
  @Throttle(STRICT_THROTTLE)
  @ApiOperation({
    summary: 'Register a new school (tenant) and its proprietor account',
    description:
      'Creates the school, copies the system roles into it, creates the proprietor user and returns a signed-in session.',
  })
  @ApiCreatedResponse({ type: SessionDto })
  register(
    @Body() dto: RegisterSchoolDto,
    @Req() req: Request,
  ): Promise<SessionDto> {
    return this.auth.registerSchool(dto, this.meta(req));
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({ summary: 'Sign in and receive an access/refresh token pair' })
  @ApiOkResponse({ type: SessionDto })
  @ApiUnauthorizedResponse({
    description: 'Invalid credentials or locked account',
  })
  @ApiTooManyRequestsResponse({ description: 'Too many attempts' })
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<SessionDto> {
    return this.auth.login(dto, this.meta(req));
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new token pair',
    description:
      'Refresh tokens rotate on every use. Replaying a used token revokes the whole token family.',
  })
  @ApiOkResponse({ type: AuthTokensDto })
  refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
  ): Promise<AuthTokensDto> {
    return this.auth.refresh(dto.refreshToken, this.meta(req));
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a single refresh token' })
  @ApiOkResponse({ type: MessageDto })
  async logout(@Body() dto: RefreshTokenDto): Promise<MessageDto> {
    await this.auth.logout(dto.refreshToken);
    return { message: 'Signed out' };
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @AllowNoTenant()
  @ApiOperation({ summary: 'Revoke every session for the current user' })
  @ApiOkResponse({ type: MessageDto })
  async logoutAll(@CurrentUser() auth: AuthContext): Promise<MessageDto> {
    await this.auth.logoutAll(auth.userId);
    return { message: 'All sessions have been signed out' };
  }

  @Post('switch-school/:schoolId')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @AllowNoTenant()
  @ApiOperation({
    summary: 'Issue tokens for another school the current user belongs to',
    description:
      'Membership is verified server-side; the school id alone grants nothing.',
  })
  @ApiOkResponse({ type: SessionDto })
  switchSchool(
    @CurrentUser() auth: AuthContext,
    @Param('schoolId', ParseUUIDPipe) schoolId: string,
    @Req() req: Request,
  ): Promise<SessionDto> {
    return this.auth.switchSchool(auth, schoolId, this.meta(req));
  }

  @Get('me')
  @ApiBearerAuth()
  @AllowNoTenant()
  @ApiOperation({
    summary: 'Current user, active school, memberships and permissions',
  })
  @ApiOkResponse({ type: ProfileDto })
  me(@CurrentUser() auth: AuthContext): Promise<ProfileDto> {
    return this.auth.getProfile(auth);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @AllowNoTenant()
  @ApiOperation({
    summary: 'Change the current user password (revokes all sessions)',
  })
  @ApiOkResponse({ type: MessageDto })
  async changePassword(
    @CurrentUser() auth: AuthContext,
    @Body() dto: ChangePasswordDto,
  ): Promise<MessageDto> {
    await this.auth.changePassword(auth, dto);
    return { message: 'Password changed. Please sign in again.' };
  }

  @Post('forgot-password')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(STRICT_THROTTLE)
  @ApiOperation({
    summary: 'Request a password reset link',
    description:
      'Always returns the same response, whether or not the email exists.',
  })
  @ApiOkResponse({ type: MessageDto })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<MessageDto> {
    await this.auth.forgotPassword(dto.email);
    return {
      message: 'If that email is registered, a reset link has been sent.',
    };
  }

  @Post('reset-password')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({ summary: 'Set a new password using a reset token' })
  @ApiOkResponse({ type: MessageDto })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<MessageDto> {
    await this.auth.resetPassword(dto.token, dto.password);
    return { message: 'Password updated. You can now sign in.' };
  }

  @Post('verify-email')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Confirm an email address with a verification token',
  })
  @ApiBody({ type: TokenDto })
  @ApiOkResponse({ type: MessageDto })
  async verifyEmail(@Body() dto: TokenDto): Promise<MessageDto> {
    await this.auth.verifyEmail(dto.token);
    return { message: 'Email address verified' };
  }

  @Post('resend-verification')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(STRICT_THROTTLE)
  @ApiOperation({ summary: 'Resend the email verification link' })
  @ApiOkResponse({ type: MessageDto })
  async resendVerification(
    @Body() dto: ResendVerificationDto,
  ): Promise<MessageDto> {
    await this.auth.resendVerification(dto.email);
    return {
      message: 'If that email needs verification, a new link has been sent.',
    };
  }
}
