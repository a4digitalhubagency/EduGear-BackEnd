import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FeeStructureStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/** Well beyond any real termly fee, but low enough to catch a slipped zero. */
export const MAX_FEE_AMOUNT = 100_000_000;
export const MAX_STRUCTURE_ITEMS = 50;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class FeeStructureItemInputDto {
  @ApiProperty() @IsUUID() categoryId: string;

  @ApiProperty({ example: 45000, maximum: MAX_FEE_AMOUNT })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_FEE_AMOUNT)
  amount: number;

  @ApiPropertyOptional({
    default: false,
    description: 'Billed only when a parent opts in, e.g. a bus place',
  })
  @IsBoolean()
  @IsOptional()
  isOptional?: boolean;
}

export class CreateFeeStructureDto {
  @ApiProperty({ example: 'JSS1 First Term 2025/2026' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiProperty() @IsUUID() sessionId: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Omit for a charge covering the whole session',
  })
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  @IsOptional()
  termId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Omit to apply to every class',
  })
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  @IsOptional()
  classId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  @IsOptional()
  description?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @ValidateIf((_, value) => value !== null)
  @Type(() => Date)
  @IsDate()
  @IsOptional()
  dueDate?: Date | null;

  @ApiProperty({ type: [FeeStructureItemInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_STRUCTURE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => FeeStructureItemInputDto)
  items: FeeStructureItemInputDto[];
}

/**
 * `sessionId`, `termId` and `classId` are absent: they decide who the structure
 * applies to, and invoices already issued were built from that decision.
 */
export class UpdateFeeStructureDto {
  @ApiPropertyOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  @IsOptional()
  description?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @ValidateIf((_, value) => value !== null)
  @Type(() => Date)
  @IsDate()
  @IsOptional()
  dueDate?: Date | null;

  @ApiPropertyOptional({
    type: [FeeStructureItemInputDto],
    description: 'Replaces the item list wholesale when given',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_STRUCTURE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => FeeStructureItemInputDto)
  @IsOptional()
  items?: FeeStructureItemInputDto[];
}

const SORTABLE = ['name', 'totalAmount', 'createdAt'] as const;

export class QueryFeeStructuresDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsUUID() @IsOptional() sessionId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() termId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() classId?: string;

  @ApiPropertyOptional({ enum: FeeStructureStatus })
  @IsEnum(FeeStructureStatus)
  @IsOptional()
  status?: FeeStructureStatus;

  @ApiPropertyOptional({ enum: SORTABLE, default: 'createdAt' })
  @IsIn(SORTABLE)
  @IsOptional()
  sortBy: (typeof SORTABLE)[number] = 'createdAt';
}

export class FeeStructureItemDto {
  @ApiProperty() id: string;
  @ApiProperty() categoryId: string;
  @ApiProperty() categoryName: string;
  @ApiProperty() amount: number;
  @ApiProperty() isOptional: boolean;
}

export class FeeStructureDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) description: string | null;
  @ApiProperty() sessionId: string;
  @ApiProperty() sessionName: string;
  @ApiPropertyOptional({ nullable: true }) termId: string | null;
  @ApiPropertyOptional({ nullable: true }) termName: string | null;
  @ApiPropertyOptional({ nullable: true }) classId: string | null;
  @ApiPropertyOptional({ nullable: true }) className: string | null;
  @ApiProperty({ enum: FeeStructureStatus }) status: FeeStructureStatus;
  @ApiPropertyOptional({ nullable: true, type: String, format: 'date' })
  dueDate: Date | null;
  @ApiProperty({ description: 'Sum of the compulsory items' })
  totalAmount: number;
  @ApiProperty({ type: [FeeStructureItemDto] }) items: FeeStructureItemDto[];
  @ApiProperty({ description: 'Invoices issued from this structure' })
  invoiceCount: number;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
