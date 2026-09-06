import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const toBool = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class CreateFeeCategoryDto {
  @ApiProperty({ example: 'Tuition' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  @IsOptional()
  description?: string | null;
}

export class UpdateFeeCategoryDto {
  @ApiPropertyOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  @IsOptional()
  description?: string | null;

  @ApiPropertyOptional({
    description: 'Retire a category without deleting the history behind it',
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

const SORTABLE = ['name', 'createdAt'] as const;

export class QueryFeeCategoriesDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @Transform(toBool)
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({ enum: SORTABLE, default: 'name' })
  @IsIn(SORTABLE)
  @IsOptional()
  sortBy: (typeof SORTABLE)[number] = 'name';
}

export class FeeCategoryDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) description: string | null;
  @ApiProperty() isActive: boolean;
  @ApiProperty({ description: 'Fee structures using this category' })
  usageCount: number;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
