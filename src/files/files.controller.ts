import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { FilePurpose } from '@prisma/client';
import { AUDIT_ACTIONS } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { CurrentSchool } from '../common/decorators';
import { PaginatedDto } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { FileDto, QueryFilesDto, UploadFileDto } from './dto/file.dto';
import { MAX_UPLOAD_BYTES } from './file-policy';
import { FilesService } from './files.service';

/** One shape for every upload endpoint. */
export const uploadInterceptor = () =>
  UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  );

@ApiTags('Files')
@ApiBearerAuth()
@Controller('files')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly audit: AuditService,
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
  ) {}

  @Post()
  @uploadInterceptor()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a file',
    description:
      'The bytes decide what the file is; a declared content type that disagrees is refused.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'purpose'],
      properties: {
        file: { type: 'string', format: 'binary' },
        purpose: { type: 'string', enum: Object.values(FilePurpose) },
        studentId: { type: 'string', format: 'uuid' },
      },
    },
  })
  @ApiCreatedResponse({ type: FileDto })
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadFileDto,
    @CurrentSchool() schoolId: string,
  ): Promise<FileDto> {
    if (!file) {
      throw AppException.badRequest(
        'No file was attached — send it as the "file" part',
        ErrorCode.VALIDATION_ERROR,
      );
    }
    await this.files.assertMayUpload(dto.purpose);

    let link: { type: 'Student'; id: string } | undefined;
    if (dto.studentId) {
      const student = await this.prisma.student.findUnique({
        where: { id: dto.studentId },
        select: { id: true },
      });
      if (!student) throw AppException.notFound('Student');
      link = { type: 'Student', id: student.id };
    }

    const uploaded = await this.files.upload(
      {
        buffer: file.buffer,
        originalName: file.originalname,
        declaredType: file.mimetype,
        purpose: dto.purpose,
        link,
      },
      schoolId,
    );

    await this.audit.record({
      action: AUDIT_ACTIONS.FILE_UPLOADED,
      entityType: 'FileObject',
      entityId: uploaded.id,
      description: `Uploaded ${uploaded.displayName}`,
      metadata: {
        purpose: uploaded.purpose,
        sizeBytes: uploaded.sizeBytes,
        studentId: dto.studentId,
      },
    });
    return uploaded;
  }

  @Get()
  @ApiOperation({ summary: 'List files of one kind' })
  list(@Query() query: QueryFilesDto): Promise<PaginatedDto<FileDto>> {
    if (!query.purpose) {
      throw AppException.badRequest(
        'Say which kind of file you are looking for',
        ErrorCode.VALIDATION_ERROR,
      );
    }
    return this.files.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Download a file',
    description:
      'Staff by permission; a parent for their own child, or for what they uploaded.',
  })
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.files.download(id);
    response
      .setHeader('Content-Type', file.contentType)
      // Inline so a photo renders, but named, and never sniffed as something
      // else — helmet sets X-Content-Type-Options: nosniff globally.
      .setHeader(
        'Content-Disposition',
        `inline; filename="${file.displayName.replace(/"/g, '')}"`,
      )
      .setHeader('Cache-Control', 'private, max-age=300')
      .send(file.body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a file nothing is using' })
  @ApiNoContentResponse()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.files.remove(id);
    await this.audit.record({
      action: AUDIT_ACTIONS.FILE_DELETED,
      entityType: 'FileObject',
      entityId: id,
    });
  }
}
