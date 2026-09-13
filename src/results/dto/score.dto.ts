import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResultSheetStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsUUID,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class ScoreSheetQueryDto {
  @ApiProperty() @IsUUID() classArmId: string;
  @ApiProperty() @IsUUID() subjectId: string;
  @ApiProperty() @IsUUID() termId: string;
}

export class ScoreEntryDto {
  @ApiProperty() @IsUUID() studentId: string;
  @ApiProperty() @IsUUID() componentId: string;

  @ApiProperty({
    nullable: true,
    example: 8.5,
    description: 'Null clears a score that was entered by mistake',
  })
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  score: number | null;
}

export class SaveScoresDto extends ScoreSheetQueryDto {
  @ApiProperty({ type: [ScoreEntryDto] })
  @IsArray()
  @ArrayMinSize(1)
  // A 60-student arm with a five-part scheme, with room to spare.
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ScoreEntryDto)
  entries: ScoreEntryDto[];
}

export class ScoreCellDto {
  @ApiProperty() componentId: string;
  @ApiPropertyOptional({ nullable: true }) score: number | null;
}

export class ScoreRowDto {
  @ApiProperty() studentId: string;
  @ApiProperty() admissionNumber: string;
  @ApiProperty() studentName: string;
  @ApiProperty({ type: [ScoreCellDto] }) scores: ScoreCellDto[];
  @ApiProperty() total: number;
  @ApiPropertyOptional({ nullable: true }) grade: string | null;
  @ApiProperty() complete: boolean;
}

export class ScoreSheetComponentDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() maxScore: number;
}

export class ScoreSheetDto {
  @ApiProperty() classArmId: string;
  @ApiProperty() className: string;
  @ApiProperty() subjectId: string;
  @ApiProperty() subjectName: string;
  @ApiProperty() isCompulsory: boolean;
  @ApiProperty() termId: string;
  @ApiProperty() termName: string;
  @ApiProperty() sessionName: string;
  @ApiProperty({ enum: ResultSheetStatus }) status: ResultSheetStatus;
  @ApiProperty({ description: 'Submitted or later: scores are frozen' })
  locked: boolean;
  @ApiProperty({ description: 'Whether you may change these scores now' })
  canEdit: boolean;
  @ApiProperty({ type: [ScoreSheetComponentDto] })
  components: ScoreSheetComponentDto[];
  @ApiProperty({ type: [ScoreRowDto] }) students: ScoreRowDto[];
  @ApiProperty() entered: number;
  @ApiProperty({
    description:
      'Cells a compulsory subject needs; electives count only takers',
  })
  expected: number;
}
