import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TermName } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class CreateTermDto {
  @ApiProperty({ description: 'The session this term belongs to' })
  @IsUUID()
  sessionId: string;

  @ApiProperty({ enum: TermName, example: TermName.FIRST })
  @IsEnum(TermName)
  name: TermName;

  @ApiProperty({ example: '2025-09-15', type: String, format: 'date' })
  @Type(() => Date)
  @IsDate()
  startDate: Date;

  @ApiProperty({ example: '2025-12-19', type: String, format: 'date' })
  @Type(() => Date)
  @IsDate()
  endDate: Date;

  @ApiPropertyOptional({
    default: false,
    description: 'Marks this the current term; its session must be current',
  })
  @IsBoolean()
  @IsOptional()
  isCurrent?: boolean;
}

/**
 * `sessionId` is deliberately absent: moving a term to another session would
 * change what its dates must fall within and what it may collide with. Delete
 * and recreate instead.
 */
export class UpdateTermDto {
  @ApiPropertyOptional({ enum: TermName })
  @IsEnum(TermName)
  @IsOptional()
  name?: TermName;

  @ApiPropertyOptional({ example: '2025-09-15', type: String, format: 'date' })
  @Type(() => Date)
  @IsDate()
  @IsOptional()
  startDate?: Date;

  @ApiPropertyOptional({ example: '2025-12-19', type: String, format: 'date' })
  @Type(() => Date)
  @IsDate()
  @IsOptional()
  endDate?: Date;
}

const SORTABLE = ['startDate', 'name', 'createdAt'] as const;

export class QueryTermsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Restrict to one session' })
  @IsUUID()
  @IsOptional()
  sessionId?: string;

  @ApiPropertyOptional({ enum: SORTABLE, default: 'startDate' })
  @IsIn(SORTABLE)
  @IsOptional()
  sortBy: (typeof SORTABLE)[number] = 'startDate';

  @ApiPropertyOptional({ description: 'Return only the current term' })
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  @IsOptional()
  isCurrent?: boolean;
}

export class TermDto {
  @ApiProperty() id: string;
  @ApiProperty() sessionId: string;
  @ApiProperty({ description: 'Name of the owning session, e.g. "2025/2026"' })
  sessionName: string;
  @ApiProperty({ enum: TermName }) name: TermName;
  @ApiProperty({ type: String, format: 'date' }) startDate: Date;
  @ApiProperty({ type: String, format: 'date' }) endDate: Date;
  @ApiProperty() isCurrent: boolean;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
