import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GuardianRelationship } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { NG_PHONE_REGEX } from '../../tenants/dto/school.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateGuardianDto {
  @ApiProperty({ example: 'Emeka' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName: string;

  @ApiProperty({ example: 'Obi' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName: string;

  @ApiProperty({
    example: '08031234567',
    description: 'Required — the school must be able to reach someone',
  })
  @Matches(NG_PHONE_REGEX, {
    message: 'phone must be a valid Nigerian phone number',
  })
  phone: string;

  @ApiPropertyOptional({ example: '08131234567', nullable: true })
  @ValidateIf((_, value) => value !== null)
  @Matches(NG_PHONE_REGEX, {
    message: 'altPhone must be a valid Nigerian phone number',
  })
  @IsOptional()
  altPhone?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, value) => value !== null)
  @IsEmail()
  @MaxLength(180)
  @IsOptional()
  email?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  @IsOptional()
  addressLine?: string | null;

  @ApiPropertyOptional({ example: 'Trader', nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(120)
  @IsOptional()
  occupation?: string | null;
}

export class UpdateGuardianDto {
  @ApiPropertyOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @IsOptional()
  firstName?: string;

  @ApiPropertyOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @IsOptional()
  lastName?: string;

  @ApiPropertyOptional()
  @Matches(NG_PHONE_REGEX, {
    message: 'phone must be a valid Nigerian phone number',
  })
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, value) => value !== null)
  @Matches(NG_PHONE_REGEX, {
    message: 'altPhone must be a valid Nigerian phone number',
  })
  @IsOptional()
  altPhone?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, value) => value !== null)
  @IsEmail()
  @MaxLength(180)
  @IsOptional()
  email?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  @IsOptional()
  addressLine?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(120)
  @IsOptional()
  occupation?: string | null;
}

const SORTABLE = ['lastName', 'firstName', 'createdAt'] as const;

export class QueryGuardiansDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Guardians linked to this student' })
  @IsUUID()
  @IsOptional()
  studentId?: string;

  @ApiPropertyOptional({ enum: SORTABLE, default: 'lastName' })
  @IsIn(SORTABLE)
  @IsOptional()
  sortBy: (typeof SORTABLE)[number] = 'lastName';
}

/** Body for linking a guardian to a student. */
export class LinkGuardianDto {
  @ApiProperty()
  @IsUUID()
  guardianId: string;

  @ApiProperty({ enum: GuardianRelationship })
  @IsEnum(GuardianRelationship)
  relationship: GuardianRelationship;

  @ApiPropertyOptional({
    default: false,
    description: 'At most one primary guardian per student',
  })
  @IsBoolean()
  @IsOptional()
  isPrimary?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  canPickUp?: boolean;
}

export class UpdateGuardianLinkDto {
  @ApiPropertyOptional({ enum: GuardianRelationship })
  @IsEnum(GuardianRelationship)
  @IsOptional()
  relationship?: GuardianRelationship;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isPrimary?: boolean;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  canPickUp?: boolean;
}

export class GuardianWardDto {
  @ApiProperty() studentId: string;
  @ApiProperty({ description: 'Admission number' }) admissionNumber: string;
  @ApiProperty() fullName: string;
  @ApiPropertyOptional({ nullable: true }) className: string | null;
  @ApiProperty({ enum: GuardianRelationship })
  relationship: GuardianRelationship;
  @ApiProperty() isPrimary: boolean;
  @ApiProperty() canPickUp: boolean;
}

export class GuardianDto {
  @ApiProperty() id: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
  @ApiProperty() fullName: string;
  @ApiProperty() phone: string;
  @ApiPropertyOptional({ nullable: true }) altPhone: string | null;
  @ApiPropertyOptional({ nullable: true }) email: string | null;
  @ApiPropertyOptional({ nullable: true }) addressLine: string | null;
  @ApiPropertyOptional({ nullable: true }) occupation: string | null;
  @ApiProperty({ description: 'Students linked to this guardian' })
  wardCount: number;
  @ApiProperty({
    description: 'True once the parent has accepted a portal login',
  })
  hasPortalAccess: boolean;
  @ApiProperty({
    enum: ['NONE', 'INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED'],
    description: 'Where the parent-portal login stands',
  })
  portalStatus: string;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class GuardianProfileDto extends GuardianDto {
  @ApiProperty({ type: [GuardianWardDto] })
  wards: GuardianWardDto[];
}
