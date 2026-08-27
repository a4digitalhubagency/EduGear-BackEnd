import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class CreateAcademicSessionDto {
  @ApiProperty({
    example: '2025/2026',
    description: 'Two consecutive years, separated by a slash',
  })
  @IsString()
  @MaxLength(9)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  name: string;

  @ApiProperty({ example: '2025-09-15', type: String, format: 'date' })
  @Type(() => Date)
  @IsDate()
  startDate: Date;

  @ApiProperty({ example: '2026-07-24', type: String, format: 'date' })
  @Type(() => Date)
  @IsDate()
  endDate: Date;

  @ApiPropertyOptional({
    default: false,
    description: 'Marks this the current session, clearing any other',
  })
  @IsBoolean()
  @IsOptional()
  isCurrent?: boolean;
}

export class UpdateAcademicSessionDto {
  @ApiPropertyOptional({ example: '2025/2026' })
  @IsString()
  @MaxLength(9)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: '2025-09-15', type: String, format: 'date' })
  @Type(() => Date)
  @IsDate()
  @IsOptional()
  startDate?: Date;

  @ApiPropertyOptional({ example: '2026-07-24', type: String, format: 'date' })
  @Type(() => Date)
  @IsDate()
  @IsOptional()
  endDate?: Date;
}

const SORTABLE = ['startDate', 'name', 'createdAt'] as const;

export class QueryAcademicSessionsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SORTABLE, default: 'startDate' })
  @IsIn(SORTABLE)
  @IsOptional()
  sortBy: (typeof SORTABLE)[number] = 'startDate';

  @ApiPropertyOptional({ description: 'Return only the current session' })
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  @IsOptional()
  isCurrent?: boolean;
}

export class AcademicSessionDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ type: String, format: 'date' }) startDate: Date;
  @ApiProperty({ type: String, format: 'date' }) endDate: Date;
  @ApiProperty() isCurrent: boolean;
  @ApiProperty({ description: 'Terms defined within this session' })
  termCount: number;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
