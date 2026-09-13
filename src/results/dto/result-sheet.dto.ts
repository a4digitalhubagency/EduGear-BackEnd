import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResultSheetStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ComputeSheetDto {
  @ApiProperty() @IsUUID() classArmId: string;
  @ApiProperty() @IsUUID() termId: string;
}

export class ReturnSheetDto {
  @ApiProperty({
    example: 'Mathematics exam scores for JSS1 A need re-checking',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;
}

export class SheetCommentDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'Form teacher, until approval',
  })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(500)
  @IsOptional()
  formTeacherComment?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Principal, until publication',
  })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(500)
  @IsOptional()
  principalComment?: string | null;
}

export class QueryResultSheetsDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsUUID() @IsOptional() termId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() classArmId?: string;

  @ApiPropertyOptional({ enum: ResultSheetStatus })
  @IsEnum(ResultSheetStatus)
  @IsOptional()
  status?: ResultSheetStatus;
}

export class ResultSheetSummaryDto {
  @ApiProperty() id: string;
  @ApiProperty() classArmId: string;
  @ApiProperty() className: string;
  @ApiProperty() termId: string;
  @ApiProperty() termName: string;
  @ApiProperty() sessionName: string;
  @ApiProperty({ enum: ResultSheetStatus }) status: ResultSheetStatus;
  @ApiProperty() studentCount: number;
  @ApiPropertyOptional({ nullable: true }) computedAt: Date | null;
  @ApiProperty({
    description:
      'Scores changed since the last compute; recompute before relying on it',
  })
  stale: boolean;
  @ApiPropertyOptional({ nullable: true }) submittedAt: Date | null;
  @ApiPropertyOptional({ nullable: true }) approvedAt: Date | null;
  @ApiPropertyOptional({ nullable: true }) publishedAt: Date | null;
  @ApiPropertyOptional({ nullable: true }) returnedReason: string | null;
}

export class SheetStudentDto {
  @ApiProperty() studentId: string;
  @ApiProperty() admissionNumber: string;
  @ApiProperty() studentName: string;
  @ApiProperty() totalScore: number;
  @ApiProperty() averageScore: number;
  @ApiPropertyOptional({ nullable: true }) position: number | null;
  @ApiPropertyOptional({ nullable: true, example: '2nd' }) positionLabel:
    string | null;
  @ApiProperty() subjectCount: number;
  @ApiProperty() passes: number;
  @ApiProperty() failures: number;
  @ApiPropertyOptional({ nullable: true }) formTeacherComment: string | null;
  @ApiPropertyOptional({ nullable: true }) principalComment: string | null;
}

export class SheetSubjectStatsDto {
  @ApiProperty() subjectId: string;
  @ApiProperty() subjectName: string;
  @ApiProperty() highest: number;
  @ApiProperty() lowest: number;
  @ApiProperty() average: number;
  @ApiProperty() studentCount: number;
}

export class MissingScoreDto {
  @ApiProperty() studentId: string;
  @ApiProperty() studentName: string;
  @ApiProperty() subjectId: string;
  @ApiProperty() subjectName: string;
  @ApiProperty({ type: [String] }) components: string[];
}

export class ResultSheetDto extends ResultSheetSummaryDto {
  @ApiProperty({
    type: [SheetStudentDto],
    description: 'In class-position order',
  })
  students: SheetStudentDto[];
  @ApiProperty({ type: [SheetSubjectStatsDto] })
  subjects: SheetSubjectStatsDto[];
  @ApiProperty({
    type: [MissingScoreDto],
    description: 'Live for a draft; always empty once submitted',
  })
  missing: MissingScoreDto[];
  @ApiProperty({ description: 'A draft with every score in, ready to submit' })
  ready: boolean;
}
