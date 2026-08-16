import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MembershipStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { NG_PHONE_REGEX } from '../../tenants/dto/school.dto';

const normaliseEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class InviteUserDto {
  @ApiProperty({ example: 'teacher@brightstar.edu.ng' })
  @IsEmail()
  @MaxLength(180)
  @Transform(normaliseEmail)
  email: string;

  @ApiProperty({ example: 'Chioma' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  firstName: string;

  @ApiProperty({ example: 'Nwosu' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  lastName: string;

  @ApiProperty({ description: 'Role id from GET /schools/me/roles' })
  @IsUUID()
  roleId: string;

  @ApiPropertyOptional({ example: '08031234567' })
  @Matches(NG_PHONE_REGEX, {
    message: 'phone must be a valid Nigerian phone number',
  })
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({
    description: 'School-issued staff number',
    example: 'STF-014',
  })
  @IsString()
  @MaxLength(40)
  @IsOptional()
  staffId?: string;
}

export class AcceptInvitationDto {
  @ApiProperty()
  @IsString()
  @MaxLength(256)
  token: string;

  @ApiProperty({ minLength: 10 })
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  password: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(60)
  @IsOptional()
  firstName?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(60)
  @IsOptional()
  lastName?: string;

  @ApiPropertyOptional({ example: '08031234567' })
  @Matches(NG_PHONE_REGEX, {
    message: 'phone must be a valid Nigerian phone number',
  })
  @IsOptional()
  phone?: string;
}

export class UpdateMembershipDto {
  @ApiPropertyOptional({ description: 'New role id' })
  @IsUUID()
  @IsOptional()
  roleId?: string;

  @ApiPropertyOptional({
    enum: [MembershipStatus.ACTIVE, MembershipStatus.SUSPENDED],
  })
  @IsIn([MembershipStatus.ACTIVE, MembershipStatus.SUSPENDED])
  @IsOptional()
  status?: MembershipStatus;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(40)
  @IsOptional()
  staffId?: string;
}

export class QueryUsersDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: MembershipStatus })
  @IsEnum(MembershipStatus)
  @IsOptional()
  status?: MembershipStatus;

  @ApiPropertyOptional({ description: 'Filter by role id' })
  @IsUUID()
  @IsOptional()
  roleId?: string;

  @ApiPropertyOptional({
    enum: ['createdAt', 'lastName', 'email'],
    default: 'createdAt',
  })
  @IsIn(['createdAt', 'lastName', 'email'])
  @IsOptional()
  sortBy: 'createdAt' | 'lastName' | 'email' = 'createdAt';
}

export class StaffMemberDto {
  @ApiProperty() membershipId: string;
  @ApiProperty() userId: string;
  @ApiProperty() email: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
  @ApiPropertyOptional() phone: string | null;
  @ApiPropertyOptional() staffId: string | null;
  @ApiProperty() roleId: string;
  @ApiProperty() roleName: string;
  @ApiProperty() roleSlug: string;
  @ApiProperty({ enum: MembershipStatus }) status: MembershipStatus;
  @ApiProperty() emailVerified: boolean;
  @ApiPropertyOptional() lastLoginAt: Date | null;
  @ApiProperty() createdAt: Date;
}
