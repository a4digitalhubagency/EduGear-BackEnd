import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class FinanceReportQueryDto {
  @ApiPropertyOptional() @IsUUID() @IsOptional() sessionId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() termId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() classId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() classArmId?: string;
}

export class DebtorQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsUUID() @IsOptional() sessionId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() termId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() classArmId?: string;

  @ApiPropertyOptional({
    description: 'Only debts at or above this amount',
    example: 1000,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  minBalance?: number;

  @ApiPropertyOptional({ description: 'Only invoices past their due date' })
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  @IsOptional()
  overdueOnly?: boolean;
}

export class FinanceSummaryDto {
  @ApiProperty({ description: 'Invoices issued' }) invoiceCount: number;
  @ApiProperty({ description: 'Students with at least one invoice' })
  studentCount: number;
  @ApiProperty({ description: 'Total billed before discounts' })
  totalBilled: number;
  @ApiProperty() totalDiscounted: number;
  @ApiProperty({ description: 'Billed less discounts' }) totalPayable: number;
  @ApiProperty({ description: 'From VERIFIED payments only' })
  totalCollected: number;
  @ApiProperty() totalOutstanding: number;
  @ApiProperty({ description: 'Recorded but not yet verified' })
  pendingVerification: number;
  @ApiProperty({ description: 'Collected as a share of payable, 0–100' })
  collectionRate: number;
  @ApiProperty({ description: 'Invoices still owing' }) debtorCount: number;
}

export class MethodBreakdownDto {
  @ApiProperty({ enum: PaymentMethod }) method: PaymentMethod;
  @ApiProperty() count: number;
  @ApiProperty() total: number;
}

export class CollectionReportDto extends FinanceSummaryDto {
  @ApiProperty({ type: [MethodBreakdownDto] })
  byMethod: MethodBreakdownDto[];
}

export class DebtorDto {
  @ApiProperty() studentId: string;
  @ApiProperty() admissionNumber: string;
  @ApiProperty() studentName: string;
  @ApiPropertyOptional({ nullable: true }) className: string | null;
  @ApiProperty({ description: 'Across all their unpaid invoices' })
  totalOwed: number;
  @ApiProperty() invoiceCount: number;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Earliest due date still unmet',
  })
  earliestDueDate: Date | null;
  @ApiProperty({ description: 'Any invoice past its due date' })
  isOverdue: boolean;
  @ApiProperty({
    type: [String],
    description: 'Guardians who can be contacted',
  })
  guardianContacts: string[];
  @ApiPropertyOptional({
    nullable: true,
    description: 'When a fee reminder was last sent about this student',
  })
  lastRemindedAt: Date | null;
}

export class SendRemindersDto {
  @ApiPropertyOptional() @IsUUID() @IsOptional() sessionId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() termId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() classArmId?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Remind only these students',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  @IsOptional()
  studentIds?: string[];

  @ApiPropertyOptional({ description: 'Only debts at or above this amount' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  minBalance?: number;

  @ApiPropertyOptional({
    default: 7,
    minimum: 0,
    maximum: 90,
    description:
      'Skip students reminded within this many days. 0 turns the cooldown off.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(90)
  @IsOptional()
  cooldownDays?: number;

  @ApiPropertyOptional({ description: 'Added to the email body' })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  message?: string;

  @ApiPropertyOptional({
    description: 'Report who would be contacted without sending anything',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  dryRun?: boolean;
}

export class ReminderChildDto {
  @ApiProperty() studentId: string;
  @ApiProperty() studentName: string;
  @ApiProperty() admissionNumber: string;
  @ApiPropertyOptional({ nullable: true }) className: string | null;
  @ApiProperty({
    description: 'Outstanding, less anything awaiting verification',
  })
  amountOwed: number;
  @ApiPropertyOptional({ nullable: true }) dueDate: Date | null;
}

export class ReminderRecipientDto {
  @ApiProperty() guardianName: string;
  @ApiProperty() email: string;
  @ApiProperty({
    type: [ReminderChildDto],
    description: 'One email covers every child this parent owes for',
  })
  children: ReminderChildDto[];
  @ApiProperty() totalOwed: number;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Whether the provider accepted it; null on a dry run',
  })
  delivered: boolean | null;
}

export class UnreachableDebtorDto {
  @ApiProperty() studentId: string;
  @ApiProperty() studentName: string;
  @ApiProperty() admissionNumber: string;
  @ApiPropertyOptional({ nullable: true }) className: string | null;
  @ApiProperty() amountOwed: number;
  @ApiProperty({
    type: [String],
    description: 'Phone numbers on file, so the bursar can call instead',
  })
  guardianPhones: string[];
}

export class SkippedDebtorDto {
  @ApiProperty() studentId: string;
  @ApiProperty() studentName: string;
  @ApiProperty({ enum: ['RECENTLY_REMINDED', 'PAYMENT_PENDING'] })
  reason: 'RECENTLY_REMINDED' | 'PAYMENT_PENDING';
  @ApiProperty() detail: string;
}

export class SendRemindersResultDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'Groups this send in the reminder history; null on a dry run',
  })
  batchId: string | null;
  @ApiProperty() dryRun: boolean;
  @ApiProperty({ description: 'Students owing money under the filters' })
  debtors: number;
  @ApiProperty({ description: 'Emails sent, or that would be sent' })
  sent: number;
  @ApiProperty({ description: 'Emails the provider refused' }) failed: number;
  @ApiProperty() studentsReminded: number;
  @ApiProperty({ description: 'Debtors with no guardian email on file' })
  skippedNoEmail: number;
  @ApiProperty({ type: [ReminderRecipientDto] })
  recipients: ReminderRecipientDto[];
  @ApiProperty({ type: [UnreachableDebtorDto] })
  unreachable: UnreachableDebtorDto[];
  @ApiProperty({ type: [SkippedDebtorDto] }) skipped: SkippedDebtorDto[];
}

export class ReminderHistoryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsUUID() @IsOptional() studentId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() batchId?: string;
}

export class ReminderHistoryDto {
  @ApiProperty() id: string;
  @ApiProperty() batchId: string;
  @ApiProperty() studentId: string;
  @ApiProperty() studentName: string;
  @ApiProperty() admissionNumber: string;
  @ApiProperty() email: string;
  @ApiProperty() amountOwed: number;
  @ApiProperty({ enum: ['SENT', 'FAILED'] }) status: string;
  @ApiProperty() sentAt: Date;
}
