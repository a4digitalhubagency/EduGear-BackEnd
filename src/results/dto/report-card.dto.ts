import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Gender, ResultSheetStatus } from '@prisma/client';
import { IsUUID } from 'class-validator';
import { SchoolLetterheadDto } from '../../tenants/dto/letterhead.dto';
import { GradeBandDto } from './assessment.dto';

export class ReportCardQueryDto {
  @ApiProperty() @IsUUID() termId: string;
}

export class ReportCardComponentDto {
  @ApiProperty() name: string;
  @ApiProperty() maxScore: number;
  @ApiPropertyOptional({ nullable: true }) score: number | null;
}

export class ReportCardSubjectDto {
  @ApiProperty() subjectName: string;
  @ApiProperty({ type: [ReportCardComponentDto] })
  components: ReportCardComponentDto[];
  @ApiProperty() total: number;
  @ApiPropertyOptional({ nullable: true }) grade: string | null;
  @ApiPropertyOptional({ nullable: true }) remark: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Null when the school hides positions',
  })
  position: number | null;
  @ApiPropertyOptional({ nullable: true, example: '3rd' })
  positionLabel: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Null when the school hides class figures',
  })
  classHighest: number | null;
  @ApiPropertyOptional({ nullable: true }) classLowest: number | null;
  @ApiPropertyOptional({ nullable: true }) classAverage: number | null;
}

export class ReportCardStudentDto {
  @ApiProperty() id: string;
  @ApiProperty() admissionNumber: string;
  @ApiProperty() fullName: string;
  @ApiProperty({ enum: Gender }) gender: Gender;
  @ApiPropertyOptional({ nullable: true }) dateOfBirth: Date | null;
  @ApiPropertyOptional({ nullable: true }) photoUrl: string | null;
}

export class ReportCardAttendanceDto {
  @ApiProperty({ description: 'Days the school recorded attendance' })
  daysOpen: number;
  @ApiProperty() present: number;
  @ApiProperty() absent: number;
  @ApiProperty() late: number;
}

export class ReportCardDto {
  @ApiProperty({ type: SchoolLetterheadDto }) school: SchoolLetterheadDto;
  @ApiProperty({ type: ReportCardStudentDto }) student: ReportCardStudentDto;
  @ApiProperty() className: string;
  @ApiProperty() termName: string;
  @ApiProperty() sessionName: string;
  @ApiPropertyOptional({ nullable: true }) nextTermBegins: Date | null;
  @ApiProperty({
    enum: ResultSheetStatus,
    description: 'Anything but PUBLISHED is provisional',
  })
  status: ResultSheetStatus;
  @ApiPropertyOptional({ nullable: true }) publishedAt: Date | null;
  @ApiProperty({ type: [ReportCardSubjectDto] })
  subjects: ReportCardSubjectDto[];
  @ApiProperty() totalScore: number;
  @ApiProperty() averageScore: number;
  @ApiPropertyOptional({ nullable: true }) position: number | null;
  @ApiPropertyOptional({ nullable: true, example: '5th' }) positionLabel:
    string | null;
  @ApiProperty({ description: 'Students ranked in the class' }) outOf: number;
  @ApiProperty() subjectCount: number;
  @ApiProperty() passes: number;
  @ApiProperty() failures: number;
  @ApiPropertyOptional({ nullable: true }) formTeacherName: string | null;
  @ApiPropertyOptional({ nullable: true }) formTeacherComment: string | null;
  @ApiPropertyOptional({ nullable: true }) principalComment: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: ReportCardAttendanceDto,
    description: 'Null when no attendance was recorded for the term',
  })
  attendance: ReportCardAttendanceDto | null;
  @ApiProperty({
    type: [GradeBandDto],
    description: 'The key printed on the card',
  })
  gradeScale: GradeBandDto[];
}
