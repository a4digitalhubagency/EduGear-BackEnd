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

export class ReminderRecipientDto {
  @ApiProperty() studentName: string;
  @ApiProperty() guardianName: string;
  @ApiProperty() email: string;
  @ApiProperty() amountOwed: number;
}

export class SendRemindersResultDto {
  @ApiProperty({ description: 'Debtors matched by the filters' })
  debtors: number;
  @ApiProperty({ description: 'Reminders sent, or that would be sent' })
  sent: number;
  @ApiProperty({ description: 'Debtors with no reachable guardian email' })
  skippedNoEmail: number;
  @ApiProperty() dryRun: boolean;
  @ApiProperty({ type: [ReminderRecipientDto] })
  recipients: ReminderRecipientDto[];
}
