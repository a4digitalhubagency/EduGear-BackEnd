import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { NG_PHONE_REGEX } from '../../tenants/dto/school.dto';

const normaliseEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class RegisterSchoolDto {
  @ApiProperty({ example: 'Bright Star College' })
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  @Transform(trim)
  schoolName: string;

  @ApiProperty({ example: 'info@brightstar.edu.ng' })
  @IsEmail()
  @MaxLength(180)
  @Transform(normaliseEmail)
  schoolEmail: string;

  @ApiPropertyOptional({ example: '08031234567' })
  @Matches(NG_PHONE_REGEX, {
    message: 'schoolPhone must be a valid Nigerian phone number',
  })
  @IsOptional()
  schoolPhone?: string;

  @ApiPropertyOptional({ example: 'Ibadan' })
  @IsString()
  @MaxLength(80)
  @IsOptional()
  city?: string;

  @ApiPropertyOptional({ example: 'Oyo' })
  @IsString()
  @MaxLength(80)
  @IsOptional()
  state?: string;

  @ApiProperty({ example: 'Adebayo' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  @Transform(trim)
  firstName: string;

  @ApiProperty({ example: 'Ogunleye' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  @Transform(trim)
  lastName: string;

  @ApiProperty({
    example: 'adebayo@brightstar.edu.ng',
    description: 'Proprietor login email',
  })
  @IsEmail()
  @MaxLength(180)
  @Transform(normaliseEmail)
  email: string;

  @ApiPropertyOptional({ example: '08031234567' })
  @Matches(NG_PHONE_REGEX, {
    message: 'phone must be a valid Nigerian phone number',
  })
  @IsOptional()
  phone?: string;

  @ApiProperty({ minLength: 10, example: 'StrongPass123' })
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  password: string;
}

export class LoginDto {
  @ApiProperty({ example: 'adebayo@brightstar.edu.ng' })
  @IsEmail()
  @MaxLength(180)
  @Transform(normaliseEmail)
  email: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;

  @ApiPropertyOptional({
    description:
      'Optional school to sign into when the account belongs to several. Verified against the user’s memberships.',
  })
  @IsUUID()
  @IsOptional()
  schoolId?: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  refreshToken: string;
}

export class ForgotPasswordDto {
  @ApiProperty()
  @IsEmail()
  @MaxLength(180)
  @Transform(normaliseEmail)
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  token: string;

  @ApiProperty({ minLength: 10 })
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  password: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword: string;

  @ApiProperty({ minLength: 10 })
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  newPassword: string;
}

export class TokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  token: string;
}

export class ResendVerificationDto {
  @ApiProperty()
  @IsEmail()
  @MaxLength(180)
  @Transform(normaliseEmail)
  email: string;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export class AuthTokensDto {
  @ApiProperty() accessToken: string;
  @ApiProperty() refreshToken: string;
  @ApiProperty({ example: 'Bearer' }) tokenType: string;
  @ApiProperty({ description: 'Access token lifetime in seconds' })
  expiresIn: number;
}

export class AuthUserDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
  @ApiPropertyOptional() phone: string | null;
  @ApiProperty() emailVerified: boolean;
}

export class MembershipSummaryDto {
  @ApiProperty() membershipId: string;
  @ApiProperty() schoolId: string;
  @ApiProperty() schoolName: string;
  @ApiProperty() schoolSlug: string;
  @ApiProperty() roleName: string;
  @ApiProperty() roleSlug: string;
  @ApiProperty() isActive: boolean;
}

export class SessionDto {
  @ApiProperty({ type: AuthTokensDto }) tokens: AuthTokensDto;
  @ApiProperty({ type: AuthUserDto }) user: AuthUserDto;
  @ApiProperty({ type: MembershipSummaryDto })
  activeSchool: MembershipSummaryDto;
  @ApiProperty({ type: [MembershipSummaryDto] })
  memberships: MembershipSummaryDto[];
  @ApiProperty({ type: [String] }) permissions: string[];
}

export class ProfileDto {
  @ApiProperty({ type: AuthUserDto }) user: AuthUserDto;
  @ApiProperty({ type: MembershipSummaryDto })
  activeSchool: MembershipSummaryDto;
  @ApiProperty({ type: [MembershipSummaryDto] })
  memberships: MembershipSummaryDto[];
  @ApiProperty({ type: [String] }) permissions: string[];
}

export class MessageDto {
  @ApiProperty() message: string;
}
