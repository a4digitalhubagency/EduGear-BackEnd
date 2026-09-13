import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MAX_BULK_STUDENTS } from './bulk.dto';

/**
 * How failures are handled.
 *
 * ATOMIC  — any row failing imports nothing. The safe default: the corrected
 *           file can simply be run again.
 * PARTIAL — good rows import, failing rows come back with reasons. For large
 *           files where one typo should not hold up a whole class; re-running
 *           only the rejects is then the registrar's job.
 */
export enum ImportMode {
  ATOMIC = 'ATOMIC',
  PARTIAL = 'PARTIAL',
}

class ImportOptionsDto {
  @ApiPropertyOptional({ enum: ImportMode, default: ImportMode.ATOMIC })
  @IsEnum(ImportMode)
  @IsOptional()
  mode: ImportMode = ImportMode.ATOMIC;

  @ApiPropertyOptional({
    default: false,
    description: 'Check every row and report, writing nothing',
  })
  @IsBoolean()
  @IsOptional()
  dryRun?: boolean;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    description: 'Used for rows with no admission date',
  })
  @Type(() => Date)
  @IsDate()
  @IsOptional()
  defaultAdmissionDate?: Date;

  @ApiPropertyOptional({ description: 'Used for rows with no class' })
  @IsUUID()
  @IsOptional()
  defaultClassArmId?: string;
}

export class ImportStudentsDto extends ImportOptionsDto {
  @ApiProperty({
    description:
      'Rows keyed by import field name (firstName, lastName, gender, classArm, guardianPhone…). Each row is validated individually so every problem is reported.',
    type: 'array',
    items: { type: 'object' },
    maxItems: MAX_BULK_STUDENTS,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BULK_STUDENTS)
  @IsObject({ each: true })
  rows: Record<string, unknown>[];
}

export class ImportStudentsCsvDto extends ImportOptionsDto {
  @ApiProperty({
    description:
      'The CSV file contents, header row first. GET /students/import/template for the layout.',
  })
  @IsString()
  @MinLength(1)
  // 500 rows of full detail sit well under this.
  @MaxLength(1_500_000)
  csv: string;
}

export class ImportIssueDto {
  @ApiProperty() field: string;
  @ApiProperty() message: string;
}

export enum ImportRowStatus {
  IMPORTED = 'IMPORTED',
  VALID = 'VALID',
  FAILED = 'FAILED',
}

export class ImportRowResultDto {
  @ApiProperty({ description: '1-based position among the data rows' })
  row: number;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Physical line in the CSV, when imported from one',
  })
  line: number | null;
  @ApiProperty({ enum: ImportRowStatus }) status: ImportRowStatus;
  @ApiPropertyOptional({ nullable: true }) studentName: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Assigned number — or, on a dry run, the one it would get',
  })
  admissionNumber: string | null;
  @ApiPropertyOptional({ nullable: true }) studentId: string | null;
  @ApiPropertyOptional({ nullable: true }) className: string | null;
  @ApiPropertyOptional({
    nullable: true,
    enum: ['CREATED', 'MATCHED', 'SHARED'],
    description:
      'CREATED new, MATCHED to one already on file, SHARED with an earlier row (a sibling)',
  })
  guardian: 'CREATED' | 'MATCHED' | 'SHARED' | null;
  @ApiProperty({ type: [ImportIssueDto] }) errors: ImportIssueDto[];
  @ApiProperty({ type: [String] }) warnings: string[];
}

export enum ImportOutcome {
  IMPORTED = 'IMPORTED',
  PARTIAL = 'PARTIAL',
  REJECTED = 'REJECTED',
  VALIDATED = 'VALIDATED',
}

export class ImportReportDto {
  @ApiProperty({
    enum: ImportOutcome,
    description:
      'IMPORTED everything · PARTIAL some rows · REJECTED nothing written · VALIDATED dry run',
  })
  outcome: ImportOutcome;
  @ApiProperty({ enum: ImportMode }) mode: ImportMode;
  @ApiProperty() dryRun: boolean;
  @ApiProperty() total: number;
  @ApiProperty() imported: number;
  @ApiProperty({ description: 'Rows that passed but were not written' })
  valid: number;
  @ApiProperty() failed: number;
  @ApiProperty() guardiansCreated: number;
  @ApiProperty() guardiansMatched: number;
  @ApiProperty({
    type: [String],
    description: 'About the file as a whole, e.g. columns that were ignored',
  })
  fileWarnings: string[];
  @ApiProperty({ type: [ImportRowResultDto] }) rows: ImportRowResultDto[];
}
