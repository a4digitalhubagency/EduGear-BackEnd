import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { AdmitStudentDto, StudentDto } from './student.dto';

/** One request should stay well inside a request timeout and a sane payload. */
export const MAX_BULK_STUDENTS = 500;

export class BulkAdmitStudentsDto {
  @ApiProperty({ type: [AdmitStudentDto], maxItems: MAX_BULK_STUDENTS })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BULK_STUDENTS)
  @ValidateNested({ each: true })
  @Type(() => AdmitStudentDto)
  students: AdmitStudentDto[];
}

export class BulkAdmitResultDto {
  @ApiProperty() imported: number;
  @ApiProperty({ type: [StudentDto] }) students: StudentDto[];
}

export class PromoteStudentsDto {
  @ApiProperty({ description: 'Arm the students are leaving' })
  @IsUUID()
  fromClassArmId: string;

  @ApiPropertyOptional({
    description: 'Arm they move into. Omit when graduating.',
  })
  @IsUUID()
  @IsOptional()
  toClassArmId?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Mark the students GRADUATED and clear their arm instead',
  })
  @IsBoolean()
  @IsOptional()
  graduate?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description: 'Defaults to every ACTIVE student in the source arm',
  })
  @IsArray()
  @ArrayMaxSize(MAX_BULK_STUDENTS)
  @IsUUID('4', { each: true })
  @IsOptional()
  studentIds?: string[];
}

export class PromotionResultDto {
  @ApiProperty({ description: 'Students moved into the target arm' })
  promoted: number;
  @ApiProperty({ description: 'Students marked GRADUATED' })
  graduated: number;
  @ApiPropertyOptional({ nullable: true, description: '"JSS1 A"' })
  from: string | null;
  @ApiPropertyOptional({ nullable: true }) to: string | null;
}
