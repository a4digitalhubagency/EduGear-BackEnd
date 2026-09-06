import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StudentFeeStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { MAX_FEE_AMOUNT } from './fee-structure.dto';

/** One class arm's worth of invoices in a single call. */
export const MAX_ASSIGN_STUDENTS = 500;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class AssignFeeDto {
  @ApiProperty({ description: 'A PUBLISHED fee structure' })
  @IsUUID()
  structureId: string;

  @ApiPropertyOptional({
    description: 'Invoice every ACTIVE student in this arm',
  })
  @IsUUID()
  @IsOptional()
  classArmId?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Or invoice exactly these students',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ASSIGN_STUDENTS)
  @IsUUID('4', { each: true })
  @IsOptional()
  studentIds?: string[];

  @ApiPropertyOptional({
    description: 'Optional item ids from the structure to include in the bill',
    type: [String],
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  @IsOptional()
  includeOptionalItemIds?: string[];

  @ApiPropertyOptional({ type: String, format: 'date' })
  @Type(() => Date)
  @IsDate()
  @IsOptional()
  dueDate?: Date;
}

export class DiscountFeeDto {
  @ApiProperty({ example: 5000, description: 'Absolute naira amount' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_FEE_AMOUNT)
  amount: number;

  @ApiProperty({ example: 'Sibling discount' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  reason: string;
}

export class WaiveFeeDto {
  @ApiProperty({ example: 'Staff child — full scholarship' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  reason: string;
}

const SORTABLE = ['createdAt', 'dueDate', 'totalAmount'] as const;

export class QueryStudentFeesDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsUUID() @IsOptional() studentId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() structureId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() sessionId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() termId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() classArmId?: string;

  @ApiPropertyOptional({ enum: StudentFeeStatus })
  @IsEnum(StudentFeeStatus)
  @IsOptional()
  status?: StudentFeeStatus;

  @ApiPropertyOptional({
    description: 'Only invoices still owing money (UNPAID or PARTIAL)',
  })
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @ValidateIf((_, value) => value !== undefined)
  @IsOptional()
  owing?: boolean;

  @ApiPropertyOptional({ enum: SORTABLE, default: 'createdAt' })
  @IsIn(SORTABLE)
  @IsOptional()
  sortBy: (typeof SORTABLE)[number] = 'createdAt';
}

export class StudentFeeItemDto {
  @ApiProperty() id: string;
  @ApiProperty() categoryName: string;
  @ApiProperty() amount: number;
}

export class StudentFeeDto {
  @ApiProperty() id: string;
  @ApiProperty() studentId: string;
  @ApiProperty({ description: 'Admission number' }) admissionNumber: string;
  @ApiProperty() studentName: string;
  @ApiPropertyOptional({ nullable: true }) className: string | null;
  @ApiProperty() structureId: string;
  @ApiProperty() structureName: string;
  @ApiProperty() sessionId: string;
  @ApiPropertyOptional({ nullable: true }) termId: string | null;
  @ApiProperty({ description: 'What was billed' }) totalAmount: number;
  @ApiProperty() discountAmount: number;
  @ApiProperty({ description: 'totalAmount less any discount' })
  payableAmount: number;
  @ApiProperty({ description: 'From VERIFIED payments only' })
  amountPaid: number;
  @ApiProperty({ description: 'Still outstanding' }) balance: number;
  @ApiProperty({ enum: StudentFeeStatus }) status: StudentFeeStatus;
  @ApiPropertyOptional({ nullable: true, type: String, format: 'date' })
  dueDate: Date | null;
  @ApiPropertyOptional({ nullable: true }) waiverReason: string | null;
  @ApiProperty({ type: [StudentFeeItemDto] }) items: StudentFeeItemDto[];
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class AssignFeeResultDto {
  @ApiProperty({ description: 'Invoices created' }) assigned: number;
  @ApiProperty({ description: 'Students who already had this invoice' })
  skipped: number;
  @ApiProperty() totalBilled: number;
  @ApiProperty({ type: [StudentFeeDto] }) invoices: StudentFeeDto[];
}
