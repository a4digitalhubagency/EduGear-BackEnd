import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class QueryNotificationsDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  @IsOptional()
  unreadOnly?: boolean;
}

export class NotificationDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: NotificationType }) type: NotificationType;
  @ApiProperty() title: string;
  @ApiProperty() body: string;
  @ApiProperty({ description: 'Ids to link through, e.g. studentId, termId' })
  data: Record<string, unknown>;
  @ApiProperty() read: boolean;
  @ApiPropertyOptional({ nullable: true }) readAt: Date | null;
  @ApiProperty() createdAt: Date;
}
