import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FilePurpose } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PERMISSIONS } from '../common/constants/permissions';
import { CurrentSchool, RequirePermissions } from '../common/decorators';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { MAX_UPLOAD_BYTES } from '../files/file-policy';
import { FilesService } from '../files/files.service';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { RoleDto, SchoolDto, UpdateSchoolDto } from './dto/school.dto';
import { SchoolsService } from './schools.service';

@ApiTags('School')
@ApiBearerAuth()
@Controller('schools')
export class SchoolsController {
  constructor(
    private readonly schools: SchoolsService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
  ) {}

  @Get('me')
  @RequirePermissions(PERMISSIONS.SCHOOL_READ)
  @ApiOperation({ summary: 'Get the authenticated school profile' })
  @ApiOkResponse({ type: SchoolDto })
  getCurrent(): Promise<SchoolDto> {
    return this.schools.getCurrentSchool();
  }

  @Patch('me')
  @RequirePermissions(PERMISSIONS.SCHOOL_UPDATE)
  @ApiOperation({ summary: 'Update the authenticated school profile' })
  @ApiOkResponse({ type: SchoolDto })
  async update(@Body() dto: UpdateSchoolDto): Promise<SchoolDto> {
    const school = await this.schools.updateCurrentSchool(dto);
    await this.audit.record({
      action: AUDIT_ACTIONS.SCHOOL_UPDATED,
      entityType: 'School',
      entityId: school.id,
      metadata: { fields: Object.keys(dto) },
    });
    return school;
  }

  @Get('me/roles')
  @RequirePermissions(PERMISSIONS.ROLES_READ)
  @ApiOperation({ summary: 'List roles and their permissions for this school' })
  @ApiOkResponse({ type: [RoleDto] })
  listRoles(): Promise<RoleDto[]> {
    return this.schools.listRoles();
  }

  @Get('me/permissions')
  @RequirePermissions(PERMISSIONS.ROLES_READ)
  @ApiOperation({ summary: 'List the permission catalogue' })
  async listPermissions() {
    const permissions = await this.prisma.permission.findMany({
      orderBy: [{ group: 'asc' }, { key: 'asc' }],
    });
    return permissions.map((p) => ({
      key: p.key,
      group: p.group,
      description: p.description,
    }));
  }

  @Post('me/logo')
  @RequirePermissions(PERMISSIONS.SCHOOL_UPDATE)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Set the school logo',
    description:
      'Appears on receipts, statements and report cards. Replaces the old one.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOkResponse({ type: SchoolDto })
  async setLogo(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentSchool() schoolId: string,
  ): Promise<SchoolDto> {
    if (!file) {
      throw AppException.badRequest(
        'No logo was attached — send it as the "file" part',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const uploaded = await this.files.replaceLinked(
      FilePurpose.SCHOOL_LOGO,
      { type: 'School', id: schoolId },
      {
        buffer: file.buffer,
        originalName: file.originalname,
        declaredType: file.mimetype,
      },
      schoolId,
    );
    const school = await this.schools.setLogo(uploaded.url);

    await this.audit.record({
      action: AUDIT_ACTIONS.SCHOOL_UPDATED,
      entityType: 'School',
      entityId: schoolId,
      description: 'Updated the school logo',
      metadata: { fields: ['logoUrl'] },
    });
    return school;
  }

  @Delete('me/logo')
  @RequirePermissions(PERMISSIONS.SCHOOL_UPDATE)
  @ApiOperation({ summary: 'Remove the school logo' })
  @ApiOkResponse({ type: SchoolDto })
  async removeLogo(@CurrentSchool() schoolId: string): Promise<SchoolDto> {
    await this.files.removeLinked(FilePurpose.SCHOOL_LOGO, {
      type: 'School',
      id: schoolId,
    });
    const school = await this.schools.setLogo(null);
    await this.audit.record({
      action: AUDIT_ACTIONS.SCHOOL_UPDATED,
      entityType: 'School',
      entityId: schoolId,
      metadata: { fields: ['logoUrl'] },
    });
    return school;
  }
}
