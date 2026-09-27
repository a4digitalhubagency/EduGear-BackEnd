import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PlatformRole, SchoolStatus, UserStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class PlatformLoginDto {
  @ApiProperty({ example: 'ops@a4technologies.ng' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  password: string;
}

export class GrantPlatformAccessDto {
  @ApiProperty({
    description:
      'An existing user who belongs to no school. Platform accounts are separate on purpose.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email: string;

  @ApiProperty({ enum: PlatformRole })
  @IsEnum(PlatformRole)
  role: PlatformRole;
}

export class PlatformAdminDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() fullName: string;
  @ApiProperty({ enum: PlatformRole }) role: PlatformRole;
  @ApiProperty({ enum: UserStatus }) userStatus: UserStatus;
  @ApiPropertyOptional({ nullable: true }) lastLoginAt: Date | null;
  @ApiPropertyOptional({ nullable: true }) disabledAt: Date | null;
  @ApiProperty() createdAt: Date;
}

export class SuspendSchoolDto {
  @ApiProperty({
    example: 'Subscription unpaid since September',
    description: 'Recorded on the school’s audit trail.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  reason: string;
}

export class SetStorageQuotaDto {
  @ApiProperty({
    example: 4096,
    minimum: 1,
    maximum: 1_000_000,
    description: 'Megabytes. Null restores the platform default.',
    nullable: true,
  })
  @Type(() => Number)
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  @IsOptional()
  storageQuotaMb: number | null;
}

const SCHOOL_SORT = ['createdAt', 'name', 'status'] as const;

export class QuerySchoolsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SchoolStatus })
  @IsEnum(SchoolStatus)
  @IsOptional()
  status?: SchoolStatus;

  @ApiPropertyOptional({ enum: SCHOOL_SORT, default: 'createdAt' })
  @IsIn(SCHOOL_SORT)
  @IsOptional()
  sortBy: (typeof SCHOOL_SORT)[number] = 'createdAt';
}

/**
 * A school as A4 sees it: who they are, what state they are in, and how much
 * they use. Deliberately no student names, no fees and no results — the operator
 * surface is metadata only, so this DTO is where that line is drawn.
 */
export class PlatformSchoolDto {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) shortName: string | null;
  @ApiProperty() email: string;
  @ApiPropertyOptional({ nullable: true }) phone: string | null;
  @ApiPropertyOptional({ nullable: true }) state: string | null;
  @ApiProperty({ enum: SchoolStatus }) status: SchoolStatus;
  @ApiPropertyOptional({ nullable: true }) deletedAt: Date | null;
  @ApiProperty() createdAt: Date;

  @ApiProperty({ description: 'ACTIVE students only' }) studentCount: number;
  @ApiProperty({ description: 'Active memberships' }) staffCount: number;
  @ApiProperty() classArmCount: number;
  @ApiProperty({ description: 'Bytes stored across all uploads' })
  storageBytes: number;

  @ApiProperty({ description: 'Upload ceiling in megabytes' })
  storageQuotaMb: number;

  @ApiProperty({
    description: 'False while the school is on the platform default',
  })
  storageQuotaIsCustom: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The proprietor who registered the school',
  })
  ownerEmail: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Most recent staff login at this school',
  })
  lastActivityAt: Date | null;
}

export class PlatformStatsDto {
  @ApiProperty() totalSchools: number;
  @ApiProperty() activeSchools: number;
  @ApiProperty() suspendedSchools: number;
  @ApiProperty() pendingSchools: number;
  @ApiProperty() cancelledSchools: number;
  @ApiProperty({ description: 'ACTIVE students across every school' })
  totalStudents: number;
  @ApiProperty() totalStaff: number;
  @ApiProperty() storageBytes: number;
  @ApiProperty({ description: 'Schools registered in the last 30 days' })
  newSchoolsLast30Days: number;
}
