import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Gender, MembershipStatus, PaymentMethod } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AttendanceSummaryDto } from '../../attendance/dto/attendance.dto';

export class PortalAccessDto {
  @ApiProperty() guardianId: string;
  @ApiProperty() email: string;
  @ApiProperty({ enum: ['NONE', 'INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED'] })
  status: 'NONE' | MembershipStatus;
  @ApiPropertyOptional({ nullable: true }) invitedAt: Date | null;
  @ApiPropertyOptional({ nullable: true }) acceptedAt: Date | null;
}

export class PortalTermQueryDto {
  @ApiPropertyOptional({ description: 'Defaults to the current term' })
  @IsUUID()
  @IsOptional()
  termId?: string;
}

/**
 * A parent's claim that they have paid — lands PENDING, like any recorded
 * payment, until the bursar verifies it against the bank.
 */
export class SubmitPaymentDto {
  @ApiProperty({ description: 'The invoice this pays towards' })
  @IsUUID()
  studentFeeId: string;

  @ApiProperty({ example: 50000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100_000_000)
  amount: number;

  @ApiProperty({
    enum: [
      PaymentMethod.BANK_TRANSFER,
      PaymentMethod.POS,
      PaymentMethod.ONLINE,
      PaymentMethod.CHEQUE,
    ],
    description: 'Cash is paid at the office and recorded there',
  })
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @ApiProperty({
    example: 'TRF/2025/88123',
    description: 'Bank or teller reference',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(120)
  reference: string;

  @ApiPropertyOptional({
    description: 'Link to an uploaded teller or screenshot',
  })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  evidenceUrl?: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  paidAt: Date;
}

export class PortalLatestResultDto {
  @ApiProperty() termId: string;
  @ApiProperty() termName: string;
  @ApiProperty() sessionName: string;
  @ApiProperty() averageScore: number;
  @ApiPropertyOptional({ nullable: true }) positionLabel: string | null;
  @ApiProperty() outOf: number;
}

export class PortalChildDto {
  @ApiProperty() studentId: string;
  @ApiProperty() admissionNumber: string;
  @ApiProperty() fullName: string;
  @ApiProperty({ enum: Gender }) gender: Gender;
  @ApiPropertyOptional({ nullable: true }) photoUrl: string | null;
  @ApiPropertyOptional({ nullable: true }) className: string | null;
  @ApiProperty() relationship: string;
  @ApiProperty({ description: 'Outstanding across all invoices' })
  feeBalance: number;
  @ApiProperty({ description: 'Sent to the school, awaiting verification' })
  pendingPayments: number;
  @ApiPropertyOptional({ nullable: true, type: PortalLatestResultDto })
  latestResult: PortalLatestResultDto | null;
}

export class PortalOverviewDto extends PortalChildDto {
  @ApiPropertyOptional({ nullable: true }) formTeacherName: string | null;
  @ApiPropertyOptional({ nullable: true }) currentTermId: string | null;
  @ApiPropertyOptional({ nullable: true }) currentTermName: string | null;
  @ApiPropertyOptional({ nullable: true, type: AttendanceSummaryDto })
  attendance: AttendanceSummaryDto | null;
}

export class PortalMeDto {
  @ApiProperty() guardianId: string;
  @ApiProperty() fullName: string;
  @ApiProperty() phone: string;
  @ApiPropertyOptional({ nullable: true }) email: string | null;
  @ApiProperty() schoolName: string;
  @ApiProperty({ type: [PortalChildDto] }) children: PortalChildDto[];
  @ApiProperty() unreadNotifications: number;
}

export class PortalResultTermDto extends PortalLatestResultDto {
  @ApiPropertyOptional({ nullable: true }) publishedAt: Date | null;
}
