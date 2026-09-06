import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, PaymentStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
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

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class RecordPaymentDto {
  @ApiProperty({ description: 'The invoice being paid' })
  @IsUUID()
  studentFeeId: string;

  @ApiProperty({ example: 20000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_FEE_AMOUNT)
  amount: number;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Teller number, transfer reference or POS stub',
  })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(120)
  @IsOptional()
  reference?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Uploaded evidence' })
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(500)
  @IsOptional()
  evidenceUrl?: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  paidAt: Date;

  @ApiPropertyOptional({ nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  @IsOptional()
  note?: string | null;
}

export class RejectPaymentDto {
  @ApiProperty({ example: 'No matching credit on the bank statement' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  reason: string;
}

const SORTABLE = ['paidAt', 'amount', 'createdAt'] as const;

export class QueryPaymentsDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsUUID() @IsOptional() studentId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() studentFeeId?: string;

  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsEnum(PaymentStatus)
  @IsOptional()
  status?: PaymentStatus;

  @ApiPropertyOptional({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  @IsOptional()
  method?: PaymentMethod;

  @ApiPropertyOptional({ type: String, format: 'date' })
  @Type(() => Date)
  @IsDate()
  @IsOptional()
  paidFrom?: Date;

  @ApiPropertyOptional({ type: String, format: 'date' })
  @Type(() => Date)
  @IsDate()
  @IsOptional()
  paidTo?: Date;

  @ApiPropertyOptional({ enum: SORTABLE, default: 'paidAt' })
  @IsIn(SORTABLE)
  @IsOptional()
  sortBy: (typeof SORTABLE)[number] = 'paidAt';
}

export class PaymentDto {
  @ApiProperty() id: string;
  @ApiProperty() studentFeeId: string;
  @ApiProperty() studentId: string;
  @ApiProperty() studentName: string;
  @ApiProperty({ description: 'Admission number' }) admissionNumber: string;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Issued on verification only',
  })
  receiptNumber: string | null;
  @ApiProperty() amount: number;
  @ApiProperty({ enum: PaymentMethod }) method: PaymentMethod;
  @ApiPropertyOptional({ nullable: true }) reference: string | null;
  @ApiPropertyOptional({ nullable: true }) evidenceUrl: string | null;
  @ApiProperty() paidAt: Date;
  @ApiProperty({ enum: PaymentStatus }) status: PaymentStatus;
  @ApiPropertyOptional({ nullable: true }) note: string | null;
  @ApiPropertyOptional({ nullable: true }) verifiedAt: Date | null;
  @ApiPropertyOptional({ nullable: true }) rejectionReason: string | null;
  @ApiProperty({ description: 'Invoice balance after this payment' })
  invoiceBalance: number;
  @ApiProperty() createdAt: Date;
}
