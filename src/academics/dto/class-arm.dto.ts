import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export const MAX_ARM_CAPACITY = 500;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateClassArmDto {
  @ApiProperty({ description: 'The class this arm belongs to' })
  @IsUUID()
  classId: string;

  @ApiProperty({ example: 'A', description: 'Unique within its class' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name: string;

  @ApiPropertyOptional({ example: 35, maximum: MAX_ARM_CAPACITY })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ARM_CAPACITY)
  @IsOptional()
  capacity?: number;

  @ApiPropertyOptional({
    description: 'Membership id of the form teacher; must be active staff here',
  })
  @IsUUID()
  @IsOptional()
  formTeacherId?: string;
}

/** `classId` is omitted: an arm cannot move between classes. */
export class UpdateClassArmDto {
  @ApiPropertyOptional({ example: 'B' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ maximum: MAX_ARM_CAPACITY, nullable: true })
  @Type(() => Number)
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(MAX_ARM_CAPACITY)
  @IsOptional()
  capacity?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Pass null to clear the form teacher',
  })
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  @IsOptional()
  formTeacherId?: string | null;
}

const SORTABLE = ['name', 'createdAt'] as const;

export class QueryClassArmsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Restrict to one class' })
  @IsUUID()
  @IsOptional()
  classId?: string;

  @ApiPropertyOptional({ enum: SORTABLE, default: 'name' })
  @IsIn(SORTABLE)
  @IsOptional()
  sortBy: (typeof SORTABLE)[number] = 'name';
}

export class ClassArmDto {
  @ApiProperty() id: string;
  @ApiProperty() classId: string;
  @ApiProperty() className: string;
  @ApiProperty() classLevel: number;
  @ApiProperty() name: string;
  @ApiProperty({ description: '"JSS1 A" — how a school actually refers to it' })
  fullName: string;
  @ApiPropertyOptional({ nullable: true }) capacity: number | null;
  @ApiPropertyOptional({ nullable: true }) formTeacherId: string | null;
  @ApiPropertyOptional({ nullable: true }) formTeacherName: string | null;
  @ApiProperty({ description: 'Active students in this arm' })
  studentCount: number;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
