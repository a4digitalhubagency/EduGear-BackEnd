import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { StudentStatus } from '@prisma/client';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { PERMISSIONS } from '../common/constants/permissions';
import { CurrentSchool, RequirePermissions } from '../common/decorators';
import { PaginatedDto } from '../common/dto/pagination.dto';
import {
  BulkAdmitResultDto,
  BulkAdmitStudentsDto,
  PromoteStudentsDto,
  PromotionResultDto,
} from './dto/bulk.dto';
import {
  AdmitStudentDto,
  ChangeStudentStatusDto,
  QueryStudentsDto,
  StudentDto,
  StudentProfileDto,
  UpdateStudentDto,
} from './dto/student.dto';
import { StudentsService } from './students.service';

@ApiTags('Students')
@ApiBearerAuth()
@Controller('students')
export class StudentsController {
  constructor(
    private readonly students: StudentsService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.STUDENTS_CREATE)
  @ApiOperation({ summary: 'Admit a student' })
  @ApiCreatedResponse({ type: StudentDto })
  async admit(
    @Body() dto: AdmitStudentDto,
    @CurrentSchool() schoolId: string,
  ): Promise<StudentDto> {
    const student = await this.students.admit(dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.STUDENT_CREATED,
      entityType: 'Student',
      entityId: student.id,
      description: `Admitted ${student.fullName} (${student.studentId})`,
      metadata: {
        studentId: student.studentId,
        classArmId: student.classArmId,
      },
    });
    return student;
  }

  @Post('bulk')
  @RequirePermissions(PERMISSIONS.STUDENTS_CREATE)
  @ApiOperation({
    summary: 'Import many students at once',
    description:
      'All rows or none: a partial import cannot be safely re-run once admission numbers exist.',
  })
  @ApiCreatedResponse({ type: BulkAdmitResultDto })
  async bulkAdmit(
    @Body() dto: BulkAdmitStudentsDto,
    @CurrentSchool() schoolId: string,
  ): Promise<BulkAdmitResultDto> {
    const result = await this.students.bulkAdmit(dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.STUDENT_BULK_IMPORTED,
      entityType: 'Student',
      description: `Imported ${result.imported} students`,
      metadata: {
        imported: result.imported,
        admissionNumbers: result.students.map((s) => s.studentId),
      },
    });
    return result;
  }

  @Post('promotions')
  @RequirePermissions(PERMISSIONS.STUDENTS_UPDATE)
  @ApiOperation({
    summary: 'Promote or graduate a class arm',
    description:
      'Moves every ACTIVE student in the source arm, or the listed subset.',
  })
  @ApiOkResponse({ type: PromotionResultDto })
  @HttpCode(HttpStatus.OK)
  async promote(@Body() dto: PromoteStudentsDto): Promise<PromotionResultDto> {
    const result = await this.students.promote(dto);
    await this.audit.record({
      action: result.graduated
        ? AUDIT_ACTIONS.STUDENT_GRADUATED
        : AUDIT_ACTIONS.STUDENT_PROMOTED,
      entityType: 'ClassArm',
      entityId: dto.fromClassArmId,
      description: result.graduated
        ? `Graduated ${result.graduated} students from ${result.from}`
        : `Promoted ${result.promoted} students from ${result.from} to ${result.to}`,
      metadata: { ...result },
    });
    return result;
  }

  @Get()
  @RequirePermissions(PERMISSIONS.STUDENTS_READ)
  @ApiOperation({
    summary: 'List students',
    description:
      'Returns ACTIVE students unless status is given; pass status=ALL for every status.',
  })
  list(@Query() query: QueryStudentsDto): Promise<PaginatedDto<StudentDto>> {
    return this.students.list(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.STUDENTS_READ)
  @ApiOperation({ summary: 'Get a student profile, guardians included' })
  @ApiOkResponse({ type: StudentProfileDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<StudentProfileDto> {
    return this.students.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.STUDENTS_UPDATE)
  @ApiOperation({ summary: 'Update a student' })
  @ApiOkResponse({ type: StudentDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStudentDto,
  ): Promise<StudentDto> {
    const student = await this.students.update(id, dto);
    await this.audit.record({
      action: AUDIT_ACTIONS.STUDENT_UPDATED,
      entityType: 'Student',
      entityId: student.id,
      metadata: { fields: Object.keys(dto) },
    });
    return student;
  }

  @Patch(':id/status')
  @RequirePermissions(PERMISSIONS.STUDENTS_UPDATE)
  @ApiOperation({ summary: 'Change a student’s status' })
  @ApiOkResponse({ type: StudentDto })
  async changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeStudentStatusDto,
  ): Promise<StudentDto> {
    const student = await this.students.changeStatus(id, dto);
    await this.audit.record({
      // Leaving the school is the event schools actually look for in the trail.
      action:
        dto.status === StudentStatus.ACTIVE
          ? AUDIT_ACTIONS.STUDENT_UPDATED
          : AUDIT_ACTIONS.STUDENT_DEACTIVATED,
      entityType: 'Student',
      entityId: student.id,
      description: `${student.fullName} is now ${student.status}`,
      metadata: { status: student.status, reason: dto.reason },
    });
    return student;
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.STUDENTS_DELETE)
  @ApiOperation({
    summary: 'Delete a student record',
    description:
      'Permanent. Prefer a status change so the record survives for reporting.',
  })
  @ApiNoContentResponse()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.students.remove(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.STUDENT_DELETED,
      entityType: 'Student',
      entityId: id,
    });
  }
}
