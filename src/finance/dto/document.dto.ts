import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, PaymentStatus, StudentFeeStatus } from '@prisma/client';
import { IsOptional, IsUUID } from 'class-validator';

export class SchoolLetterheadDto {
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) addressLine: string | null;
  @ApiPropertyOptional({ nullable: true }) city: string | null;
  @ApiPropertyOptional({ nullable: true }) state: string | null;
  @ApiPropertyOptional({ nullable: true }) phone: string | null;
  @ApiProperty() email: string;
  @ApiPropertyOptional({ nullable: true }) logoUrl: string | null;
  @ApiPropertyOptional({ nullable: true }) motto: string | null;
}

export class DocumentStudentDto {
  @ApiProperty() id: string;
  @ApiProperty() admissionNumber: string;
  @ApiProperty() fullName: string;
  @ApiPropertyOptional({ nullable: true }) className: string | null;
}

export class ReceiptDto {
  @ApiProperty() receiptNumber: string;
  @ApiProperty({ description: 'When the payment was verified' })
  issuedAt: Date;
  @ApiProperty({ type: SchoolLetterheadDto }) school: SchoolLetterheadDto;
  @ApiProperty({ type: DocumentStudentDto }) student: DocumentStudentDto;
  @ApiProperty() invoiceId: string;
  @ApiProperty() feeDescription: string;
  @ApiProperty() amount: number;
  @ApiProperty({ example: 'Fifty thousand naira only' }) amountInWords: string;
  @ApiProperty({ enum: PaymentMethod }) method: PaymentMethod;
  @ApiPropertyOptional({ nullable: true }) reference: string | null;
  @ApiProperty() paidAt: Date;
  @ApiProperty({ description: 'What the invoice asks for after discounts' })
  invoicePayable: number;
  @ApiProperty({
    description: 'Paid on this invoice up to and including this receipt',
  })
  paidToDate: number;
  @ApiProperty({ description: 'Outstanding immediately after this payment' })
  balanceAfter: number;
  @ApiPropertyOptional({ nullable: true }) receivedBy: string | null;
}

export class StatementQueryDto {
  @ApiPropertyOptional() @IsUUID() @IsOptional() sessionId?: string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() termId?: string;
}

export class LedgerEntryDto {
  @ApiProperty() date: Date;
  @ApiProperty({ enum: ['INVOICE', 'DISCOUNT', 'WAIVER', 'PAYMENT'] })
  type: string;
  @ApiProperty() description: string;
  @ApiProperty() debit: number;
  @ApiProperty() credit: number;
  @ApiProperty() balance: number;
  @ApiPropertyOptional({ nullable: true, description: 'Receipt number' })
  reference: string | null;
}

export class StatementInvoiceDto {
  @ApiProperty() id: string;
  @ApiProperty() structureName: string;
  @ApiProperty() totalAmount: number;
  @ApiProperty() discountAmount: number;
  @ApiProperty() amountPaid: number;
  @ApiProperty() balance: number;
  @ApiProperty({ enum: StudentFeeStatus }) status: StudentFeeStatus;
  @ApiPropertyOptional({ nullable: true }) dueDate: Date | null;
}

export class StatementPaymentDto {
  @ApiProperty() id: string;
  @ApiPropertyOptional({ nullable: true }) receiptNumber: string | null;
  @ApiProperty() amount: number;
  @ApiProperty({ enum: PaymentMethod }) method: PaymentMethod;
  @ApiProperty({ enum: PaymentStatus }) status: PaymentStatus;
  @ApiProperty() paidAt: Date;
  @ApiPropertyOptional({ nullable: true }) rejectionReason: string | null;
}

export class StatementDto {
  @ApiProperty({ type: SchoolLetterheadDto }) school: SchoolLetterheadDto;
  @ApiProperty({ type: DocumentStudentDto }) student: DocumentStudentDto;
  @ApiProperty() generatedAt: Date;
  @ApiProperty() totalBilled: number;
  @ApiProperty() totalDiscounted: number;
  @ApiProperty() totalPaid: number;
  @ApiProperty() totalWaived: number;
  @ApiProperty() closingBalance: number;
  @ApiProperty({ description: 'Recorded but not yet verified' })
  pendingVerification: number;
  @ApiProperty({ type: [StatementInvoiceDto] }) invoices: StatementInvoiceDto[];
  @ApiProperty({ type: [LedgerEntryDto] }) ledger: LedgerEntryDto[];
  @ApiProperty({ type: [StatementPaymentDto] }) payments: StatementPaymentDto[];
}
