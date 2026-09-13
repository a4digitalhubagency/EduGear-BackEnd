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
  Put,
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
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { PERMISSIONS } from '../common/constants/permissions';
import { CurrentSchool, RequirePermissions } from '../common/decorators';
import { PaginatedDto } from '../common/dto/pagination.dto';
import {
  AssignTeacherDto,
  ClassSubjectDto,
  CreateSubjectDto,
  OfferSubjectDto,
  QuerySubjectsDto,
  SubjectDto,
  TeachingAssignmentDto,
  TeachingAssignmentQueryDto,
  UpdateClassSubjectDto,
  UpdateSubjectDto,
} from './dto/subject.dto';
import { SubjectsService } from './subjects.service';

@ApiTags('Results')
@ApiBearerAuth()
@Controller('results')
export class SubjectsController {
  constructor(
    private readonly subjects: SubjectsService,
    private readonly audit: AuditService,
  ) {}

  @Post('subjects')
  @RequirePermissions(PERMISSIONS.ACADEMICS_CREATE)
  @ApiOperation({ summary: 'Create a subject' })
  @ApiCreatedResponse({ type: SubjectDto })
  async create(
    @Body() dto: CreateSubjectDto,
    @CurrentSchool() schoolId: string,
  ): Promise<SubjectDto> {
    const subject = await this.subjects.create(dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.SUBJECT_CREATED,
      entityType: 'Subject',
      entityId: subject.id,
      description: `Created subject ${subject.name} (${subject.code})`,
    });
    return subject;
  }

  @Get('subjects')
  @RequirePermissions(PERMISSIONS.ACADEMICS_READ)
  @ApiOperation({ summary: 'List subjects' })
  list(@Query() query: QuerySubjectsDto): Promise<PaginatedDto<SubjectDto>> {
    return this.subjects.list(query);
  }

  @Get('subjects/:id')
  @RequirePermissions(PERMISSIONS.ACADEMICS_READ)
  @ApiOperation({ summary: 'Get one subject' })
  @ApiOkResponse({ type: SubjectDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<SubjectDto> {
    return this.subjects.findOne(id);
  }

  @Patch('subjects/:id')
  @RequirePermissions(PERMISSIONS.ACADEMICS_UPDATE)
  @ApiOperation({ summary: 'Update or retire a subject' })
  @ApiOkResponse({ type: SubjectDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSubjectDto,
  ): Promise<SubjectDto> {
    const subject = await this.subjects.update(id, dto);
    await this.audit.record({
      action: AUDIT_ACTIONS.SUBJECT_UPDATED,
      entityType: 'Subject',
      entityId: id,
      metadata: { fields: Object.keys(dto) },
    });
    return subject;
  }

  @Delete('subjects/:id')
  @RequirePermissions(PERMISSIONS.ACADEMICS_DELETE)
  @ApiOperation({ summary: 'Delete an unused subject' })
  @ApiNoContentResponse()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.subjects.remove(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.SUBJECT_DELETED,
      entityType: 'Subject',
      entityId: id,
    });
  }

  @Get('classes/:classId/subjects')
  @RequirePermissions(PERMISSIONS.ACADEMICS_READ)
  @ApiOperation({
    summary: 'Subjects a class offers, with the teacher per arm',
  })
  @ApiOkResponse({ type: [ClassSubjectDto] })
  classSubjects(
    @Param('classId', ParseUUIDPipe) classId: string,
  ): Promise<ClassSubjectDto[]> {
    return this.subjects.classSubjects(classId);
  }

  @Post('classes/:classId/subjects')
  @RequirePermissions(PERMISSIONS.ACADEMICS_UPDATE)
  @ApiOperation({ summary: 'Add a subject to a class' })
  @ApiCreatedResponse({ type: [ClassSubjectDto] })
  async offer(
    @Param('classId', ParseUUIDPipe) classId: string,
    @Body() dto: OfferSubjectDto,
    @CurrentSchool() schoolId: string,
  ): Promise<ClassSubjectDto[]> {
    const offered = await this.subjects.offer(classId, dto, schoolId);
    await this.audit.record({
      action: AUDIT_ACTIONS.CLASS_SUBJECT_ADDED,
      entityType: 'Class',
      entityId: classId,
      metadata: {
        subjectId: dto.subjectId,
        isCompulsory: dto.isCompulsory ?? true,
      },
    });
    return offered;
  }

  @Patch('classes/:classId/subjects/:subjectId')
  @RequirePermissions(PERMISSIONS.ACADEMICS_UPDATE)
  @ApiOperation({ summary: 'Make a class subject compulsory or elective' })
  @ApiOkResponse({ type: [ClassSubjectDto] })
  updateOffer(
    @Param('classId', ParseUUIDPipe) classId: string,
    @Param('subjectId', ParseUUIDPipe) subjectId: string,
    @Body() dto: UpdateClassSubjectDto,
  ): Promise<ClassSubjectDto[]> {
    return this.subjects.updateOffer(classId, subjectId, dto);
  }

  @Delete('classes/:classId/subjects/:subjectId')
  @RequirePermissions(PERMISSIONS.ACADEMICS_UPDATE)
  @ApiOperation({ summary: 'Stop a class offering a subject' })
  @ApiNoContentResponse()
  @HttpCode(HttpStatus.NO_CONTENT)
  async withdraw(
    @Param('classId', ParseUUIDPipe) classId: string,
    @Param('subjectId', ParseUUIDPipe) subjectId: string,
  ): Promise<void> {
    await this.subjects.withdraw(classId, subjectId);
    await this.audit.record({
      action: AUDIT_ACTIONS.CLASS_SUBJECT_REMOVED,
      entityType: 'Class',
      entityId: classId,
      metadata: { subjectId },
    });
  }

  @Put('class-arms/:classArmId/subjects/:subjectId/teacher')
  @RequirePermissions(PERMISSIONS.ACADEMICS_UPDATE)
  @ApiOperation({
    summary: 'Assign the subject teacher for an arm',
    description: 'The assigned teacher is the one who may enter the scores.',
  })
  @ApiOkResponse({ type: TeachingAssignmentDto })
  async assign(
    @Param('classArmId', ParseUUIDPipe) classArmId: string,
    @Param('subjectId', ParseUUIDPipe) subjectId: string,
    @Body() dto: AssignTeacherDto,
    @CurrentSchool() schoolId: string,
  ): Promise<TeachingAssignmentDto> {
    const assignment = await this.subjects.assignTeacher(
      classArmId,
      subjectId,
      dto,
      schoolId,
    );
    await this.audit.record({
      action: AUDIT_ACTIONS.TEACHER_ASSIGNED,
      entityType: 'ClassArm',
      entityId: classArmId,
      description: `${assignment.teacherName ?? 'A teacher'} now teaches ${assignment.subjectName} to ${assignment.className}`,
      metadata: { subjectId, teacherMembershipId: dto.teacherMembershipId },
    });
    return assignment;
  }

  @Delete('class-arms/:classArmId/subjects/:subjectId/teacher')
  @RequirePermissions(PERMISSIONS.ACADEMICS_UPDATE)
  @ApiOperation({ summary: 'Remove the subject teacher for an arm' })
  @ApiNoContentResponse()
  @HttpCode(HttpStatus.NO_CONTENT)
  async unassign(
    @Param('classArmId', ParseUUIDPipe) classArmId: string,
    @Param('subjectId', ParseUUIDPipe) subjectId: string,
  ): Promise<void> {
    await this.subjects.unassignTeacher(classArmId, subjectId);
    await this.audit.record({
      action: AUDIT_ACTIONS.TEACHER_UNASSIGNED,
      entityType: 'ClassArm',
      entityId: classArmId,
      metadata: { subjectId },
    });
  }

  @Get('teaching-assignments')
  @RequirePermissions(PERMISSIONS.RESULTS_READ)
  @ApiOperation({
    summary: 'Who teaches what',
    description:
      'Pass mine=true for the classes you teach — a teacher’s starting screen.',
  })
  @ApiOkResponse({ type: [TeachingAssignmentDto] })
  assignments(
    @Query() query: TeachingAssignmentQueryDto,
  ): Promise<TeachingAssignmentDto[]> {
    return this.subjects.assignments(query);
  }
}
