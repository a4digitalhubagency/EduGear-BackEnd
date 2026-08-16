import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SchoolStatus } from '@prisma/client';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Nigerian mobile formats: 08012345678, +2348012345678, 2348012345678. */
export const NG_PHONE_REGEX = /^(\+?234|0)[789][01]\d{8}$/;

export class UpdateSchoolDto {
  @ApiPropertyOptional({ example: 'Bright Star College' })
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 'BSC' })
  @IsString()
  @MaxLength(20)
  @IsOptional()
  shortName?: string;

  @ApiPropertyOptional({ example: 'admin@brightstar.edu.ng' })
  @IsEmail()
  @MaxLength(180)
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ example: '08031234567' })
  @Matches(NG_PHONE_REGEX, {
    message: 'phone must be a valid Nigerian phone number',
  })
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(255)
  @IsOptional()
  addressLine?: string;

  @ApiPropertyOptional({ example: 'Ibadan' })
  @IsString()
  @MaxLength(80)
  @IsOptional()
  city?: string;

  @ApiPropertyOptional({ example: 'Oyo' })
  @IsString()
  @MaxLength(80)
  @IsOptional()
  state?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(180)
  @IsOptional()
  motto?: string;

  @ApiPropertyOptional()
  @IsUrl()
  @IsOptional()
  logoUrl?: string;
}

export class SchoolDto {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional() shortName: string | null;
  @ApiProperty() email: string;
  @ApiPropertyOptional() phone: string | null;
  @ApiPropertyOptional() addressLine: string | null;
  @ApiPropertyOptional() city: string | null;
  @ApiPropertyOptional() state: string | null;
  @ApiProperty() country: string;
  @ApiPropertyOptional() logoUrl: string | null;
  @ApiPropertyOptional() motto: string | null;
  @ApiProperty({ enum: SchoolStatus }) status: SchoolStatus;
  @ApiProperty() timezone: string;
  @ApiProperty() currency: string;
  @ApiProperty() createdAt: Date;
}

export class RoleDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() slug: string;
  @ApiPropertyOptional() description: string | null;
  @ApiProperty() isSystem: boolean;
  @ApiProperty() memberCount: number;
  @ApiProperty({ type: [String] }) permissions: string[];
}
