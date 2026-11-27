import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BreachStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import type { NotificationState } from '../breach-clock';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class RecordBreachDto {
  @ApiProperty({
    description:
      'When WE became aware. This starts the 72-hour clock in s.40(2) — not ' +
      'when the breach began, which goes in occurredFrom.',
    example: '2026-03-02T09:00:00.000Z',
  })
  @IsDateString()
  discoveredAt: string;

  @ApiPropertyOptional({ description: 'When the breach itself began.' })
  @IsOptional()
  @IsDateString()
  occurredFrom?: string;

  @ApiPropertyOptional({ description: 'When it stopped, if it has.' })
  @IsOptional()
  @IsDateString()
  occurredTo?: string;

  @ApiProperty({
    description:
      'GAID Art 33(5)(a) — the circumstances of the loss, unauthorised ' +
      'access or disclosure.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(20, {
    message:
      'description must actually describe what happened — a regulator reads this',
  })
  @MaxLength(5000)
  description: string;

  @ApiProperty({
    isArray: true,
    type: String,
    example: ['Student names', 'Guardian phone numbers'],
    description: 'GAID Art 33(5)(c) — categories of personal data involved.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  dataCategories: string[];

  @ApiProperty({
    description: 'GAID Art 33(5)(d) — assessment of the risk of harm.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(20)
  @MaxLength(5000)
  riskAssessment: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Likely to result in a HIGH risk. GAID Art 33(3) then requires ' +
      'affected people to be told immediately.',
  })
  @IsOptional()
  @IsBoolean()
  highRisk?: boolean;

  @ApiPropertyOptional({
    description:
      'GAID Art 33(5)(e) — individuals at real risk of significant harm.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  affectedSubjects?: number;

  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description:
      'Schools affected. Empty means platform-wide or not yet known.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('4', { each: true })
  affectedSchoolIds?: string[];

  @ApiPropertyOptional({
    description: 'GAID Art 33(5)(f) — steps taken to reduce the risk of harm.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(5000)
  containment?: string;

  @ApiProperty({ description: 'GAID Art 33(5)(h) — who can answer questions.' })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  contactName: string;

  @ApiProperty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  contactEmail: string;
}

export class UpdateBreachDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(20)
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  dataCategories?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(20)
  @MaxLength(5000)
  riskAssessment?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  highRisk?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  affectedSubjects?: number;

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('4', { each: true })
  affectedSchoolIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(5000)
  containment?: string;

  @ApiPropertyOptional({ description: 'GAID Art 33(5)(g).' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(5000)
  subjectNotification?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  subjectsNotifiedAt?: string;

  @ApiPropertyOptional({
    description: 'When the Commission was notified under s.40(2).',
  })
  @IsOptional()
  @IsDateString()
  commissionNotifiedAt?: string;

  @ApiPropertyOptional({
    description:
      'A reasoned decision that s.40(2) notification is not required. ' +
      'Recorded so a blank notification date reads as a decision rather ' +
      'than an omission.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(20, {
    message:
      'notificationNotRequiredReason must give the reasoning, not just a word',
  })
  @MaxLength(2000)
  notificationNotRequiredReason?: string;

  @ApiPropertyOptional({ enum: BreachStatus })
  @IsOptional()
  @IsEnum(BreachStatus)
  status?: BreachStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  contactName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  contactEmail?: string;
}

export class QueryBreachesDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: BreachStatus })
  @IsOptional()
  @IsEnum(BreachStatus)
  status?: BreachStatus;

  @ApiPropertyOptional({
    description: 'Only those still needing a notification decision today.',
  })
  @IsOptional()
  @Transform(
    ({ value }: { value: unknown }) => value === 'true' || value === true,
  )
  @IsBoolean()
  needsAttention?: boolean;
}

export class BreachDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'BR-2026-0001' }) reference: string;

  @ApiProperty() discoveredAt: Date;
  @ApiPropertyOptional({ nullable: true }) occurredFrom: Date | null;
  @ApiPropertyOptional({ nullable: true }) occurredTo: Date | null;

  @ApiProperty() description: string;
  @ApiProperty({ isArray: true, type: String }) dataCategories: string[];
  @ApiProperty() riskAssessment: string;
  @ApiProperty() highRisk: boolean;
  @ApiPropertyOptional({ nullable: true }) affectedSubjects: number | null;
  @ApiProperty({ isArray: true, type: String }) affectedSchoolIds: string[];

  @ApiPropertyOptional({ nullable: true }) containment: string | null;
  @ApiPropertyOptional({ nullable: true }) subjectNotification: string | null;
  @ApiPropertyOptional({ nullable: true }) subjectsNotifiedAt: Date | null;

  @ApiPropertyOptional({ nullable: true }) commissionNotifiedAt: Date | null;
  @ApiPropertyOptional({ nullable: true })
  notificationNotRequiredReason: string | null;

  @ApiProperty() contactName: string;
  @ApiProperty() contactEmail: string;
  @ApiProperty({ enum: BreachStatus }) status: BreachStatus;

  @ApiProperty({
    description: 'The moment the section 40(2) window closes.',
  })
  commissionDeadline: Date;

  @ApiProperty({
    enum: ['NOT_REQUIRED', 'DUE', 'OVERDUE', 'ON_TIME', 'LATE'],
    description: 'Where this stands against the 72-hour duty. Derived.',
  })
  notificationState: NotificationState;

  @ApiProperty({
    description:
      'Whole hours left before the deadline; negative once it has passed.',
  })
  hoursUntilDeadline: number;

  @ApiProperty({
    description: 'Overdue, or close enough that waiting is a decision.',
  })
  needsAttention: boolean;

  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
