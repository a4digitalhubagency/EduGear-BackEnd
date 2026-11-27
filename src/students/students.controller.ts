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
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiProduces,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { StudentStatus } from '@prisma/client';
import { FileInterceptor } from '@nestjs/platform-express';
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
  SensitiveDataConsentDto,
  SensitiveDataErasureDto,
  StudentDto,
  StudentProfileDto,
  UpdateStudentDto,
} from './dto/student.dto';
import {
  ImportReportDto,
  ImportStudentsCsvDto,
  ImportStudentsDto,
} from './dto/import.dto';
import { MAX_UPLOAD_BYTES } from '../files/file-policy';
import { buildTemplateCsv } from './import/import-columns';
import { StudentImportService } from './student-import.service';
import { StudentsService } from './students.service';
import {
  StudentExport,
  StudentExportService,
} from '../retention/student-export.service';

@ApiTags('Students')
@ApiBearerAuth()
@Controller('students')
export class StudentsController {
  constructor(
    private readonly students: StudentsService,
    private readonly importer: StudentImportService,
    private readonly audit: AuditService,
    private readonly accessControl: AccessControlService,
    private readonly exporter: StudentExportService,
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
    await this.auditConsent(student, dto.sensitiveDataConsent);
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
    await this.auditConsent(student, dto.sensitiveDataConsent);
    return student;
  }

  /**
   * Records the consent as its own event when a request carried one.
   *
   * Separate from the create/update entry because this is the thing a school
   * has to be able to produce on demand: section 26(2) of the NDP Act puts the
   * burden of demonstrating consent on them, and "the student record was
   * edited on the 4th" does not demonstrate it. Its own action name is what
   * makes the trail searchable for it.
   *
   * **The signatory's name is deliberately not in the metadata.** It is on the
   * student row, where the retention schedule destroys it with the data it
   * authorises; an audit entry outlives that by years, so copying the name
   * here would quietly reinstate the thing minimisation just removed. The
   * entry proves the act and its date — the row says who.
   */
  private async auditConsent(
    student: StudentDto,
    consent: SensitiveDataConsentDto | undefined,
  ): Promise<void> {
    if (!consent) return;

    await this.audit.record({
      action: AUDIT_ACTIONS.STUDENT_SENSITIVE_CONSENT_RECORDED,
      entityType: 'Student',
      entityId: student.id,
      description: `Recorded parental consent to sensitive data for ${student.fullName}`,
      metadata: {
        method: consent.method,
        givenAt: (consent.givenAt ?? new Date()).toISOString(),
      },
    });
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

  @Post(':id/photo')
  @RequirePermissions(PERMISSIONS.STUDENTS_UPDATE)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Set a student’s photo',
    description:
      'Replaces any previous photo, which is deleted rather than left behind.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOkResponse({ type: StudentDto })
  async setPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentSchool() schoolId: string,
  ): Promise<StudentDto> {
    const student = await this.students.setPhoto(id, file, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.STUDENT_UPDATED,
      entityType: 'Student',
      entityId: id,
      description: `Updated the photo for ${student.fullName}`,
      metadata: { fields: ['photoUrl'] },
    });
    return student;
  }

  @Delete(':id/photo')
  @RequirePermissions(PERMISSIONS.STUDENTS_UPDATE)
  @ApiOperation({ summary: 'Remove a student’s photo' })
  @ApiOkResponse({ type: StudentDto })
  async removePhoto(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StudentDto> {
    const student = await this.students.removePhoto(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.STUDENT_UPDATED,
      entityType: 'Student',
      entityId: id,
      metadata: { fields: ['photoUrl'] },
    });
    return student;
  }

  @Delete(':id/sensitive-data')
  @RequirePermissions(PERMISSIONS.STUDENTS_UPDATE)
  @ApiOperation({
    summary: 'Withdraw consent and erase a student’s sensitive personal data',
    description:
      'Clears genotype, blood group, religion, state of origin and LGA, and ' +
      'nothing else — and withdraws the parental consent record behind them, ' +
      'in the same write. These five are the only fields on a student record ' +
      'held under consent (NDP Act s.30(1)(a), given by a parent under ' +
      's.31(1)); everything else rests on the contract or a legal ' +
      'obligation. Because s.35(2) requires withdrawing consent to be as ' +
      'easy as giving it, this is honoured unconditionally and immediately. ' +
      'Succeeds when there is nothing to erase. Re-sending ' +
      '`sensitiveDataConsent` on the student is what reinstates it.',
  })
  @ApiOkResponse({ type: SensitiveDataErasureDto })
  async eraseSensitiveData(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SensitiveDataErasureDto> {
    const result = await this.students.eraseSensitiveData(id);

    // Recorded even when nothing was erased: "we asked and there was nothing
    // held" is exactly what a school needs to show a regulator, and it is
    // indistinguishable from "never asked" if we only log the other case.
    await this.audit.record({
      action: AUDIT_ACTIONS.STUDENT_SENSITIVE_DATA_ERASED,
      entityType: 'Student',
      entityId: id,
      description: result.erasedFields.length
        ? `Erased sensitive data for ${result.student.fullName}: ${result.erasedFields.join(', ')}`
        : `No sensitive data held for ${result.student.fullName}`,
      // Field names only. The values were the thing being erased.
      metadata: {
        erasedFields: result.erasedFields,
        // Recorded separately because it is a different fact: the data is
        // gone *and* the school no longer claims a basis to re-enter it.
        consentWithdrawn: result.consentWithdrawn,
      },
    });

    return result;
  }

  @Get(':id/export')
  // Every domain the export touches, not just students.read. The export is
  // the most concentrated view of a child this application can produce, and
  // it would otherwise be a way to read fees and results without holding the
  // permission to read fees and results.
  @RequirePermissions(
    PERMISSIONS.STUDENTS_READ,
    PERMISSIONS.GUARDIANS_READ,
    PERMISSIONS.FINANCE_READ,
    PERMISSIONS.RESULTS_READ,
    PERMISSIONS.ATTENDANCE_READ,
  )
  @ApiOperation({
    summary: 'Export everything held about a student',
    description:
      'A structured, machine-readable copy of the student’s record, for a ' +
      'subject access request under NDP Act s.34(1)(b) or portability under ' +
      's.38. Downloads as JSON.',
  })
  @ApiProduces('application/json')
  async exportRecord(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StudentExport> {
    const data = await this.exporter.export(id);

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="edugear-student-${data.student.admissionNumber as string}.json"`,
    );

    // Audited as its own action: a copy of a child's whole record leaving the
    // system is exactly the event a school needs to be able to account for,
    // and it must not look like an ordinary read.
    await this.audit.record({
      action: AUDIT_ACTIONS.STUDENT_RECORD_EXPORTED,
      entityType: 'Student',
      entityId: id,
      description: `Exported the full record for ${data.student.lastName as string}, ${data.student.firstName as string}`,
      metadata: {
        format: data.format,
        guardians: data.guardians.length,
        invoices: data.finance.length,
        results: data.results.length,
      },
    });

    return data;
  }
}
