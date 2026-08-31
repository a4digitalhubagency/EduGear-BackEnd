import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/** JSS1..SS3 is six levels; the ceiling leaves room for schools that add more. */
export const MIN_CLASS_LEVEL = 1;
export const MAX_CLASS_LEVEL = 20;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateClassDto {
  @ApiProperty({ example: 'JSS1' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name: string;

  @ApiProperty({
    example: 1,
    minimum: MIN_CLASS_LEVEL,
    maximum: MAX_CLASS_LEVEL,
    description:
      'Rank within the school. Unique per school, and what promotion steps through.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(MIN_CLASS_LEVEL)
  @Max(MAX_CLASS_LEVEL)
  level: number;
}

export class UpdateClassDto {
  @ApiPropertyOptional({ example: 'JSS One' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ minimum: MIN_CLASS_LEVEL, maximum: MAX_CLASS_LEVEL })
  @Type(() => Number)
  @IsInt()
  @Min(MIN_CLASS_LEVEL)
  @Max(MAX_CLASS_LEVEL)
  @IsOptional()
  level?: number;
}

const SORTABLE = ['level', 'name', 'createdAt'] as const;

export class QueryClassesDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SORTABLE, default: 'level' })
  @IsIn(SORTABLE)
  @IsOptional()
  sortBy: (typeof SORTABLE)[number] = 'level';
}

export class ClassDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() level: number;
  @ApiProperty({ description: 'Number of arms in this class' })
  armCount: number;
  @ApiProperty({ description: 'Active students across all arms' })
  studentCount: number;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
