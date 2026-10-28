import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { WEEKDAYS, Weekday } from '../school-days';

const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/** Same leniency as `upper`, for a list: "monday " is still Monday. */
const upperEach = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value)
    ? (value as unknown[]).map((day) =>
        typeof day === 'string' ? day.trim().toUpperCase() : day,
      )
    : value;

export class UpdateSchoolSettingsDto {
  @ApiPropertyOptional({
    nullable: true,
    example: 'BSC',
    description: 'Prefixes new admission numbers. Null for none.',
  })
  @Transform(upper)
  @ValidateIf((_, value) => value !== null)
  @Matches(/^[A-Z0-9][A-Z0-9-]{0,9}$/, {
    message:
      'admissionNumberPrefix must be 1–10 letters, digits or hyphens, e.g. BSC',
  })
  @IsOptional()
  admissionNumberPrefix?: string | null;

  @ApiPropertyOptional({ example: 'RCP' })
  @Transform(upper)
  @Matches(/^[A-Z0-9][A-Z0-9-]{0,9}$/, {
    message: 'receiptPrefix must be 1–10 letters, digits or hyphens, e.g. RCP',
  })
  @IsOptional()
  receiptPrefix?: string;

  @ApiPropertyOptional({
    description:
      'Turns the parent portal off for everyone, without revoking logins',
  })
  @IsBoolean()
  @IsOptional()
  portalEnabled?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: 90, default: 7 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(90)
  @IsOptional()
  reminderCooldownDays?: number;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 0,
    maximum: 365,
    description: 'Days to pay when a fee structure sets no due date',
  })
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  @IsOptional()
  invoiceDueDays?: number | null;

  @ApiPropertyOptional({ description: 'Print positions on report cards' })
  @IsBoolean()
  @IsOptional()
  reportShowPosition?: boolean;

  @ApiPropertyOptional({
    description: 'Print class highest, lowest and average',
  })
  @IsBoolean()
  @IsOptional()
  reportShowClassStats?: boolean;

  @ApiPropertyOptional({
    isArray: true,
    enum: WEEKDAYS,
    example: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
    description:
      'The days this school opens. A register is refused on any other day. ' +
      'At least one day is required — a school with none could never take a ' +
      'register again.',
  })
  @Transform(upperEach)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsIn(WEEKDAYS, { each: true })
  @IsOptional()
  schoolDays?: Weekday[];
}

export class SchoolSettingsDto {
  @ApiPropertyOptional({ nullable: true }) admissionNumberPrefix: string | null;
  @ApiProperty({
    description: 'What the next admission number would look like',
  })
  admissionNumberExample: string;
  @ApiProperty() receiptPrefix: string;
  @ApiProperty() portalEnabled: boolean;
  @ApiProperty() reminderCooldownDays: number;
  @ApiPropertyOptional({ nullable: true }) invoiceDueDays: number | null;
  @ApiProperty() reportShowPosition: boolean;
  @ApiProperty() reportShowClassStats: boolean;
  @ApiProperty({ isArray: true, enum: WEEKDAYS })
  schoolDays: Weekday[];
}
