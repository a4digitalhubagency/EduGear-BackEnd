import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
const toBool = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class CreateSubjectDto {
  @ApiProperty({ example: 'Mathematics' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @ApiProperty({ example: 'MTH', description: 'Short code for report cards' })
  @Transform(upper)
  @Matches(/^[A-Z0-9]{2,8}$/, {
    message: 'code must be 2–8 letters or digits, e.g. MTH',
  })
  code: string;
}

export class UpdateSubjectDto {
  @ApiPropertyOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @Transform(upper)
  @Matches(/^[A-Z0-9]{2,8}$/, {
    message: 'code must be 2–8 letters or digits, e.g. MTH',
  })
  @IsOptional()
  code?: string;

  @ApiPropertyOptional({
    description: 'Retire a subject without losing the results behind it',
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

const SORTABLE = ['name', 'code', 'createdAt'] as const;

export class QuerySubjectsDto extends PaginationQueryDto {
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

export class SubjectDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() code: string;
  @ApiProperty() isActive: boolean;
  @ApiProperty({ description: 'Classes offering this subject' })
  classCount: number;
  @ApiProperty() createdAt: Date;
}

export class OfferSubjectDto {
  @ApiProperty() @IsUUID() subjectId: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Electives count only for students with scores in them',
  })
  @IsBoolean()
  @IsOptional()
  isCompulsory?: boolean;
}

export class UpdateClassSubjectDto {
  @ApiProperty() @IsBoolean() isCompulsory: boolean;
}

export class AssignTeacherDto {
  @ApiProperty({ description: 'Membership id of an active staff member' })
  @IsUUID()
  teacherMembershipId: string;
}

export class ArmTeacherDto {
  @ApiProperty() classArmId: string;
  @ApiProperty() armName: string;
  @ApiPropertyOptional({ nullable: true }) teacherMembershipId: string | null;
  @ApiPropertyOptional({ nullable: true }) teacherName: string | null;
}

export class ClassSubjectDto {
  @ApiProperty() subjectId: string;
  @ApiProperty() name: string;
  @ApiProperty() code: string;
  @ApiProperty() isCompulsory: boolean;
  @ApiProperty({ type: [ArmTeacherDto], description: 'Teacher per arm' })
  teachers: ArmTeacherDto[];
}

export class TeachingAssignmentQueryDto {
  @ApiPropertyOptional({ description: 'Only my own assignments' })
  @Transform(toBool)
  @IsBoolean()
  @IsOptional()
  mine?: boolean;

  @ApiPropertyOptional() @IsUUID() @IsOptional() classArmId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() teacherMembershipId?: string;
}

export class TeachingAssignmentDto {
  @ApiProperty() classArmId: string;
  @ApiProperty({ description: '"JSS1 A"' }) className: string;
  @ApiProperty() subjectId: string;
  @ApiProperty() subjectName: string;
  @ApiProperty() teacherMembershipId: string;
  @ApiPropertyOptional({ nullable: true }) teacherName: string | null;
}
