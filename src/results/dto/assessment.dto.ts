import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class AssessmentComponentInputDto {
  @ApiProperty({ example: '1st CA' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name: string;

  @ApiProperty({ example: 10 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  maxScore: number;
}

export class SetAssessmentSchemeDto {
  @ApiProperty({
    type: [AssessmentComponentInputDto],
    description: 'In report-card order. Must add up to 100.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AssessmentComponentInputDto)
  components: AssessmentComponentInputDto[];
}

export class AssessmentComponentDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() maxScore: number;
  @ApiProperty() sortOrder: number;
}

export class AssessmentSchemeDto {
  @ApiProperty() configured: boolean;
  @ApiProperty({
    description: 'Scores exist, so only component names can change',
  })
  locked: boolean;
  @ApiProperty({ type: [AssessmentComponentDto] })
  components: AssessmentComponentDto[];
}

export class GradeBandInputDto {
  @ApiProperty({ example: 'A1' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(4)
  grade: string;

  @ApiProperty({ example: 75 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  minScore: number;
  @ApiProperty({ example: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  maxScore: number;

  @ApiProperty({ example: 'Excellent' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  remark: string;

  @ApiProperty() @IsBoolean() isPass: boolean;
}

export class SetGradingScaleDto {
  @ApiProperty({
    type: [GradeBandInputDto],
    description: 'Must cover 0–100 in whole marks with no gaps or overlaps',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => GradeBandInputDto)
  bands: GradeBandInputDto[];
}

export class GradeBandDto {
  @ApiProperty() grade: string;
  @ApiProperty() minScore: number;
  @ApiProperty() maxScore: number;
  @ApiProperty() remark: string;
  @ApiProperty() isPass: boolean;
}

export class GradingScaleDto {
  @ApiProperty() configured: boolean;
  @ApiProperty({ type: [GradeBandDto], description: 'Highest first' })
  bands: GradeBandDto[];
}

export class ResultsSetupDto {
  @ApiProperty({ type: AssessmentSchemeDto }) scheme: AssessmentSchemeDto;
  @ApiProperty({ type: GradingScaleDto }) grading: GradingScaleDto;
  @ApiProperty({ type: [String], description: 'What was created just now' })
  created: string[];
}
