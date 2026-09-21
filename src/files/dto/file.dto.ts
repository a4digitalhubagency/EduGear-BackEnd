import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FilePurpose } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class UploadFileDto {
  @ApiProperty({ enum: FilePurpose })
  @IsEnum(FilePurpose)
  purpose: FilePurpose;

  @ApiPropertyOptional({
    description: 'The student this file is about, where the purpose needs one',
  })
  @IsUUID()
  @IsOptional()
  studentId?: string;
}

export class QueryFilesDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: FilePurpose })
  @IsEnum(FilePurpose)
  @IsOptional()
  purpose?: FilePurpose;

  @ApiPropertyOptional() @IsUUID() @IsOptional() studentId?: string;
}

export class FileDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: FilePurpose }) purpose: FilePurpose;
  @ApiProperty({ description: 'Fetch the bytes here' }) url: string;
  @ApiProperty() displayName: string;
  @ApiProperty() contentType: string;
  @ApiProperty() sizeBytes: number;
  @ApiPropertyOptional({ nullable: true }) linkedType: string | null;
  @ApiPropertyOptional({ nullable: true }) linkedId: string | null;
  @ApiProperty() createdAt: Date;
}
