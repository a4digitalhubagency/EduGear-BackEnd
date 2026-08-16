import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class QueryAuditLogsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'auth.login.succeeded' })
  @IsString()
  @MaxLength(80)
  @IsOptional()
  action?: string;

  @ApiPropertyOptional({ example: 'Student' })
  @IsString()
  @MaxLength(60)
  @IsOptional()
  entityType?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  entityId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  actorUserId?: string;

  @ApiPropertyOptional({ description: 'ISO date — inclusive lower bound' })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date — inclusive upper bound' })
  @IsDateString()
  @IsOptional()
  to?: string;
}

export class AuditLogDto {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  description: string | null;
  metadata: unknown;
  ipAddress: string | null;
  requestId: string | null;
  createdAt: Date;
  actor: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
}
