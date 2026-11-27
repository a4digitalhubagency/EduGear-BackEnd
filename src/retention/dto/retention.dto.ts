import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

export class RetentionTaskResultDto {
  @ApiProperty({ example: 'students.minimise' })
  task: string;

  @ApiProperty({
    description: 'What this task does, in the words of the published schedule.',
  })
  description: string;

  @ApiProperty({
    description: 'Rows that match and would be acted on, or were acted on.',
  })
  affected: number;

  @ApiProperty({
    description: 'The cutoff used, so a preview can be checked by hand.',
  })
  cutoff: Date;

  @ApiPropertyOptional({
    description: 'Present when the task could not complete.',
    nullable: true,
  })
  error?: string | null;
}

export class RetentionRunDto {
  @ApiProperty({
    description:
      'False for a preview. A preview changes nothing and is the only way ' +
      'to see what a run would destroy.',
  })
  executed: boolean;

  @ApiProperty({ description: 'The single clock every task in this run used.' })
  runAt: Date;

  @ApiProperty({ type: [RetentionTaskResultDto] })
  tasks: RetentionTaskResultDto[];

  @ApiProperty({ description: 'Total rows affected across every task.' })
  totalAffected: number;
}

export class RunRetentionDto {
  @ApiPropertyOptional({
    description:
      'Run a single task by name instead of all of them. Useful when one ' +
      'task failed and you do not want to re-run the rest.',
    example: 'students.minimise',
  })
  @IsOptional()
  @IsString()
  task?: string;
}

export class PurgeSchoolDto {
  @ApiProperty({
    description:
      'The school’s exact name, typed to confirm. This cannot be undone and ' +
      'there is no second chance, so an id alone — which is copied and ' +
      'pasted, and easy to copy from the wrong row — is not enough.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  confirmSchoolName: string;

  @ApiProperty({
    description: 'Type DELETE to confirm.',
    example: 'DELETE',
  })
  @Matches(/^DELETE$/, { message: 'confirm must be exactly "DELETE"' })
  confirm: string;

  @ApiPropertyOptional({
    description:
      'Preview only: report what would be destroyed and destroy nothing.',
    default: true,
  })
  @IsOptional()
  @Transform(
    ({ value }: { value: unknown }) => value === true || value === 'true',
  )
  @IsBoolean()
  execute?: boolean;
}

export class SchoolPurgeDto {
  @ApiProperty() schoolId: string;
  @ApiProperty() schoolName: string;
  @ApiProperty({ description: 'False for a preview.' }) executed: boolean;
  @ApiProperty({
    description: 'Row counts by model, as a record of what was destroyed.',
    type: 'object',
    additionalProperties: { type: 'number' },
  })
  counts: Record<string, number>;
  @ApiProperty() purgedAt: Date;
}
