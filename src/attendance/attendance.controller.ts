import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { PERMISSIONS } from '../common/constants/permissions';
import { CurrentSchool, RequirePermissions } from '../common/decorators';
import { AttendanceService } from './attendance.service';
import {
  ArmSummaryQueryDto,
  AttendanceRecordDto,
  AttendanceSummaryDto,
  RegisterDto,
  RegisterQueryDto,
  SaveRegisterDto,
  StudentAttendanceSummaryDto,
  TermSummaryQueryDto,
} from './dto/attendance.dto';

@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance')
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly audit: AuditService,
  ) {}

  @Get('register')
  @RequirePermissions(PERMISSIONS.ATTENDANCE_READ)
  @ApiOperation({ summary: 'A class’s register for one day' })
  @ApiOkResponse({ type: RegisterDto })
  register(@Query() query: RegisterQueryDto): Promise<RegisterDto> {
    return this.attendance.register(query);
  }

  @Put('register')
  @RequirePermissions(PERMISSIONS.ATTENDANCE_CREATE)
  @ApiOperation({
    summary: 'Take or amend a register',
    description:
      'Form teacher (or administrator). A school day in a term, never a future one.',
  })
  @ApiOkResponse({ type: RegisterDto })
  async save(
    @Body() dto: SaveRegisterDto,
    @CurrentSchool() schoolId: string,
  ): Promise<RegisterDto> {
    const register = await this.attendance.save(dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.ATTENDANCE_TAKEN,
      entityType: 'ClassArm',
      entityId: dto.classArmId,
      description: `Register for ${register.className} on ${register.date.toISOString().slice(0, 10)}`,
      metadata: { entries: dto.entries.length },
    });
    return register;
  }

  @Get('summary')
  @RequirePermissions(PERMISSIONS.ATTENDANCE_READ)
  @ApiOperation({
    summary: 'Attendance for every student in a class over a term',
  })
  @ApiOkResponse({ type: [StudentAttendanceSummaryDto] })
  armSummary(
    @Query() query: ArmSummaryQueryDto,
  ): Promise<StudentAttendanceSummaryDto[]> {
    return this.attendance.armTermSummary(query.classArmId, query.termId);
  }

  @Get('students/:studentId')
  @RequirePermissions(PERMISSIONS.ATTENDANCE_READ)
  @ApiOperation({ summary: 'One student’s attendance over a term' })
  async student(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Query() query: TermSummaryQueryDto,
  ): Promise<{
    summary: AttendanceSummaryDto;
    records: AttendanceRecordDto[];
  }> {
    const [summary, records] = await Promise.all([
      this.attendance.studentTermSummary(studentId, query.termId),
      this.attendance.studentRecords(studentId, query.termId),
    ]);
    return { summary, records };
  }
}
