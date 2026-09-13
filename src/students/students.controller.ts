import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
  ApiProduces,
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
import { AccessControlService } from '../auth/access-control.service';
import { AuthContext } from '../common/context/request-context';
import {
  CurrentSchool,
  CurrentUser,
  RequirePermissions,
} from '../common/decorators';
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
import {
  ImportReportDto,
  ImportStudentsCsvDto,
  ImportStudentsDto,
} from './dto/import.dto';
import { buildTemplateCsv } from './import/import-columns';
import { StudentImportService } from './student-import.service';
import { StudentsService } from './students.service';

@ApiTags('Students')
@ApiBearerAuth()
@Controller('students')
export class StudentsController {
  constructor(
    private readonly students: StudentsService,
    private readonly importer: StudentImportService,
    private readonly audit: AuditService,
    private readonly accessControl: AccessControlService,
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

  @Get('import/template')
  @RequirePermissions(PERMISSIONS.STUDENTS_CREATE)
  @ApiOperation({
    summary: 'Download the CSV import template',
    description:
      'Headers plus two example rows (siblings sharing a parent). Opens directly in Excel.',
  })
  @ApiProduces('text/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header(
    'Content-Disposition',
    'attachment; filename="edugear-student-import-template.csv"',
  )
  template(): string {
    // The BOM makes Excel open the file as UTF-8 rather than mangling names.
    return `\uFEFF${buildTemplateCsv()}`;
  }

  @Post('import')
  @RequirePermissions(PERMISSIONS.STUDENTS_CREATE)
  @ApiOperation({
    summary: 'Import students from JSON rows',
    description:
      'Every row is checked and every problem reported. ATOMIC imports all or nothing; PARTIAL imports the good rows; dryRun writes nothing. Always 200 — read `outcome`.',
  })
  @ApiOkResponse({ type: ImportReportDto })
  @HttpCode(HttpStatus.OK)
  async importRows(
    @Body() dto: ImportStudentsDto,
    @CurrentUser() user: AuthContext,
    @CurrentSchool() schoolId: string,
  ): Promise<ImportReportDto> {
    const report = await this.importer.importRows(
      dto,
      { ...dto, ...(await this.guardianPermissions(user)) },
      schoolId,
    );
    await this.auditImport(report, 'json');
    return report;
  }

  @Post('import/csv')
  @RequirePermissions(PERMISSIONS.STUDENTS_CREATE)
  @ApiOperation({
    summary: 'Import students from a CSV file',
    description:
      'Send the file contents as `csv`. Headers are matched loosely ("Surname", "Adm No", "Sex", "Class", "Parent Phone"…); dates are DD/MM/YYYY.',
  })
  @ApiOkResponse({ type: ImportReportDto })
  @HttpCode(HttpStatus.OK)
  async importCsv(
    @Body() dto: ImportStudentsCsvDto,
    @CurrentUser() user: AuthContext,
    @CurrentSchool() schoolId: string,
  ): Promise<ImportReportDto> {
    const report = await this.importer.importCsv(
      dto,
      { ...dto, ...(await this.guardianPermissions(user)) },
      schoolId,
    );
    await this.auditImport(report, 'csv');
    return report;
  }

  @Post('bulk')
  @RequirePermissions(PERMISSIONS.STUDENTS_CREATE)
  @ApiOperation({
    summary: 'Import many students at once (all or nothing)',
    description:
      'Kept for existing callers. Prefer POST /students/import, which reports every row and supports partial imports and dry runs.',
    deprecated: true,
  })
  @ApiCreatedResponse({ type: BulkAdmitResultDto })
  async bulkAdmit(
    @Body() dto: BulkAdmitStudentsDto,
    @CurrentUser() user: AuthContext,
    @CurrentSchool() schoolId: string,
  ): Promise<BulkAdmitResultDto> {
    const result = await this.students.bulkAdmit(
      dto,
      await this.guardianPermissions(user),
      schoolId,
    );
    await this.audit.record({
      action: AUDIT_ACTIONS.STUDENT_BULK_IMPORTED,
      entityType: 'Student',
      description: `Imported ${result.imported} students`,
      metadata: { imported: result.imported, source: 'bulk' },
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

  /**
   * An import can create and link parent records, so it must not become a way
   * round the guardian permissions: the caller's own grants are passed down.
   */
  private async guardianPermissions(user: AuthContext) {
    const snapshot = await this.accessControl.getMembershipSnapshot(
      user.membershipId,
    );
    const granted = snapshot?.permissions ?? new Set<string>();
    return {
      canCreateGuardians: granted.has(PERMISSIONS.GUARDIANS_CREATE),
      canLinkGuardians: granted.has(PERMISSIONS.GUARDIANS_UPDATE),
    };
  }

  /** Recorded only when something was written; a dry run changes nothing. */
  private async auditImport(
    report: ImportReportDto,
    source: 'json' | 'csv',
  ): Promise<void> {
    if (report.imported === 0) return;
    await this.audit.record({
      action: AUDIT_ACTIONS.STUDENT_BULK_IMPORTED,
      entityType: 'Student',
      description: `Imported ${report.imported} of ${report.total} students from ${source.toUpperCase()}`,
      metadata: {
        source,
        mode: report.mode,
        imported: report.imported,
        failed: report.failed,
        guardiansCreated: report.guardiansCreated,
        guardiansMatched: report.guardiansMatched,
      },
    });
  }
}
