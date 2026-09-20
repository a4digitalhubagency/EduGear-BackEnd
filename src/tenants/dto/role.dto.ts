import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateRoleDto {
  @ApiProperty({ example: 'Head of Science' })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name: string;

  @ApiPropertyOptional({ nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  @IsOptional()
  description?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description: 'Permission keys. You can only grant permissions you hold.',
  })
  @IsArray()
  @ArrayMaxSize(80)
  @IsString({ each: true })
  @IsOptional()
  permissions?: string[];

  @ApiPropertyOptional({
    description: 'Start from an existing role’s permissions',
  })
  @IsUUID()
  @IsOptional()
  copyFromRoleId?: string;
}

export class UpdateRoleDto {
  @ApiPropertyOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  @IsOptional()
  description?: string | null;
}

export class SetRolePermissionsDto {
  @ApiProperty({
    type: [String],
    description: 'The complete set after the change — not a delta.',
  })
  @IsArray()
  @ArrayMaxSize(80)
  @IsString({ each: true })
  permissions: string[];
}

export class ReassignMembersDto {
  @ApiProperty({ description: 'Role to move this role’s members to' })
  @IsUUID()
  toRoleId: string;
}
