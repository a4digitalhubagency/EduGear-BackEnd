import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

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
}
