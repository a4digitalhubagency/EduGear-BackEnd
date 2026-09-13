import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** The school's printed identity on receipts, statements and report cards. */
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
