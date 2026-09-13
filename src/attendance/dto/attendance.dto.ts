import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttendanceStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDate,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class RegisterQueryDto {
  @ApiProperty() @IsUUID() classArmId: string;

  @ApiProperty({ type: String, format: 'date', example: '2025-10-06' })
  @Type(() => Date)
  @IsDate()
  date: Date;
}

export class RegisterEntryDto {
  @ApiProperty() @IsUUID() studentId: string;

  @ApiProperty({ enum: AttendanceStatus })
  @IsEnum(AttendanceStatus)
  status: AttendanceStatus;

  @ApiPropertyOptional({ nullable: true, example: 'Hospital appointment' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  @IsOptional()
  note?: string | null;
}

export class SaveRegisterDto extends RegisterQueryDto {
  @ApiProperty({ type: [RegisterEntryDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RegisterEntryDto)
  entries: RegisterEntryDto[];
}

export class TermSummaryQueryDto {
  @ApiProperty() @IsUUID() termId: string;
}

export class ArmSummaryQueryDto extends TermSummaryQueryDto {
  @ApiProperty() @IsUUID() classArmId: string;
}

export class RegisterRowDto {
  @ApiProperty() studentId: string;
  @ApiProperty() admissionNumber: string;
  @ApiProperty() studentName: string;
  @ApiPropertyOptional({ nullable: true, enum: AttendanceStatus })
  status: AttendanceStatus | null;
  @ApiPropertyOptional({ nullable: true }) note: string | null;
}

export class RegisterDto {
  @ApiProperty() classArmId: string;
  @ApiProperty() className: string;
  @ApiProperty({ type: String, format: 'date' }) date: Date;
  @ApiPropertyOptional({ nullable: true }) termName: string | null;
  @ApiProperty({
    description: 'Whether the register has been taken for this day',
  })
  taken: boolean;
  @ApiProperty({ description: 'Whether you may take or amend it' })
  canEdit: boolean;
  @ApiProperty({ type: [RegisterRowDto] }) students: RegisterRowDto[];
  @ApiProperty() present: number;
  @ApiProperty() absent: number;
  @ApiProperty() late: number;
  @ApiProperty() excused: number;
}

export class AttendanceSummaryDto {
  @ApiProperty({ description: 'Days a register included this student' })
  daysOpen: number;
  @ApiProperty({ description: 'Present, including late' }) present: number;
  @ApiProperty({ description: 'Absent, including excused' }) absent: number;
  @ApiProperty() late: number;
  @ApiProperty() excused: number;
  @ApiProperty({ description: 'present ÷ daysOpen, 0–100' }) rate: number;
}

export class StudentAttendanceSummaryDto extends AttendanceSummaryDto {
  @ApiProperty() studentId: string;
  @ApiProperty() studentName: string;
  @ApiProperty() admissionNumber: string;
}

export class AttendanceRecordDto {
  @ApiProperty({ type: String, format: 'date' }) date: Date;
  @ApiProperty({ enum: AttendanceStatus }) status: AttendanceStatus;
  @ApiPropertyOptional({ nullable: true }) note: string | null;
}
