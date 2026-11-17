import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ResolveAccountDto {
  @ApiProperty({ example: '0123456789', description: 'Ten digits' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  accountNumber: string;

  @ApiProperty({
    example: '058',
    description: 'Code from GET /finance/settlement/banks',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  bankCode: string;
}

/** Same fields: confirming an account and saving it take the same input. */
export class SetSettlementAccountDto extends ResolveAccountDto {}

export class ResolvedAccountDto {
  @ApiProperty({
    description: 'As the bank holds it — show this for confirmation',
    example: 'BRIGHT STAR COLLEGE',
  })
  accountName: string;

  @ApiProperty({ example: '******6789' })
  accountNumberMasked: string;
}

export class BankDto {
  @ApiProperty({ example: 'Guaranty Trust Bank' }) name: string;
  @ApiProperty({ example: '058' }) code: string;
  @ApiProperty({ example: 'NGN' }) currency: string;
}

export class SettlementAccountDto {
  @ApiProperty({
    description: 'Until this is true, the school cannot take card payments',
  })
  configured: boolean;

  @ApiPropertyOptional({ nullable: true }) bankName: string | null;
  @ApiPropertyOptional({ nullable: true }) accountName: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'The account number is never stored in full',
    example: '******6789',
  })
  accountNumberMasked: string | null;
}
