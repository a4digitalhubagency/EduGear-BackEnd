import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { FileObject, FilePurpose, Prisma } from '@prisma/client';
import { AccessControlService } from '../auth/access-control.service';
import { PERMISSIONS, PermissionKey } from '../common/constants/permissions';
import { RequestContext } from '../common/context/request-context';
import { PaginatedDto, paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { AppConfig } from '../config/configuration';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma, TxClient } from '../database/prisma.service';
import { lockSchoolScope } from '../database/row-lock';
import { FileDto, QueryFilesDto } from './dto/file.dto';
import { checkFile, safeDisplayName, storageKey } from './file-policy';
import { StorageService } from './storage/storage.service';
import { StorageQuotaDto } from './dto/file.dto';

export interface IncomingFile {
  buffer: Buffer;
  originalName?: string;
  declaredType?: string;
}

export interface UploadRequest extends IncomingFile {
  purpose: FilePurpose;
  /** Set when the file belongs to something: a student, a payment. */
  link?: { type: 'Student' | 'Payment' | 'School'; id: string };
}

/** Who may upload each kind of file. Parents are handled separately. */
const UPLOAD_PERMISSION: Record<FilePurpose, PermissionKey> = {
  STUDENT_PHOTO: PERMISSIONS.STUDENTS_UPDATE,
  SCHOOL_LOGO: PERMISSIONS.SCHOOL_UPDATE,
  PAYMENT_EVIDENCE: PERMISSIONS.FINANCE_CREATE,
};

/** Who may read each kind, as staff. */
const READ_PERMISSION: Record<FilePurpose, PermissionKey> = {
  STUDENT_PHOTO: PERMISSIONS.STUDENTS_READ,
  SCHOOL_LOGO: PERMISSIONS.SCHOOL_READ,
  PAYMENT_EVIDENCE: PERMISSIONS.FINANCE_READ,
};

/**
 * Uploaded files.
 *
 * Bytes pass through the API rather than going straight to the bucket, so the
 * file can be read before it is stored: the purpose decides what is allowed,
 * and the *bytes* decide what it is. A client's content type is a claim and is
 * only used to catch a disagreement.
 *
 * Keys are `schools/<schoolId>/<purpose>/<uuid>.<ext>` — built here, never from
 * a filename — so one school's files sit apart from another's and no upload can
 * choose where it lands. Reading goes back through this service, which checks
 * who is asking; nothing is public.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly storage: StorageService,
    private readonly accessControl: AccessControlService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async upload(request: UploadRequest, schoolId: string): Promise<FileDto> {
    if (!this.storage.usable) {
      throw AppException.conflict(
        this.storage.reason ?? 'File uploads are not available',
      );
    }

    const check = checkFile(
      request.buffer,
      request.purpose,
      request.declaredType,
    );
    if (!check.ok || !check.kind) {
      throw AppException.badRequest(
        check.error ?? 'That file cannot be accepted',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // Hoisted so the narrowing survives into the transaction's closure.
    const kind = check.kind;
    const id = randomUUID();
    const key = storageKey(schoolId, request.purpose, id, kind.extension);
    const auth = RequestContext.getAuth();

    // Written to storage first: a row pointing at bytes that are not there is
    // worse than bytes nothing points at, and the orphan is easy to sweep.
    await this.storage.driver.put(key, request.buffer, kind.contentType);

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        // The quota is a sum over every file, so there is no row to lock. The
        // advisory lock serialises check-then-insert for this school: without
        // it, uploads fired in parallel each read the same total and every one
        // of them passes, which is exactly how a quota gets overrun.
        await lockSchoolScope(tx, 'storageQuota', schoolId);
        await this.assertWithinQuota(tx, schoolId, request.buffer.length);

        return tx.fileObject.create({
          data: {
            id,
            schoolId,
            purpose: request.purpose,
            key,
            displayName: safeDisplayName(request.originalName, kind.extension),
            contentType: kind.contentType,
            sizeBytes: request.buffer.length,
            checksum: createHash('sha256').update(request.buffer).digest('hex'),
            linkedType: request.link?.type ?? null,
            linkedId: request.link?.id ?? null,
            uploadedByMembershipId: auth?.membershipId ?? null,
            uploadedByUserId: auth?.userId ?? null,
          },
        });
      });
      return this.toDto(row);
    } catch (error) {
      await this.discard(key);
      throw error;
    }
  }

  /** What this school has used and what it is allowed. */
  async quota(schoolId: string): Promise<StorageQuotaDto> {
    const [limitBytes, used] = await Promise.all([
      this.quotaBytes(schoolId),
      this.prisma.fileObject.aggregate({ _sum: { sizeBytes: true } }),
    ]);
    const usedBytes = used._sum.sizeBytes ?? 0;

    return {
      usedBytes,
      limitBytes,
      remainingBytes: Math.max(0, limitBytes - usedBytes),
      percentUsed:
        limitBytes > 0
          ? Math.min(100, Math.round((usedBytes / limitBytes) * 1000) / 10)
          : 100,
    };
  }

  /** The bytes, once the caller has been allowed to have them. */
  async download(
    id: string,
  ): Promise<{ body: Buffer; contentType: string; displayName: string }> {
    const file = await this.getOrThrow(id);
    await this.assertMayRead(file);

    try {
      return {
        body: await this.storage.driver.get(file.key),
        contentType: file.contentType,
        displayName: file.displayName,
      };
    } catch (error) {
      this.logger.error(
        `Missing object for file ${id} (${file.key}): ${error instanceof Error ? error.message : String(error)}`,
      );
      throw AppException.notFound('File contents');
    }
  }

  async list(query: QueryFilesDto): Promise<PaginatedDto<FileDto>> {
    const where: Prisma.FileObjectWhereInput = {
      ...(query.purpose ? { purpose: query.purpose } : {}),
      ...(query.studentId
        ? { linkedType: 'Student', linkedId: query.studentId }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.fileObject.findMany({
        where,
        orderBy: { createdAt: query.sortOrder },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.fileObject.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toDto(row)),
      total,
      query.page,
      query.limit,
    );
  }

  /**
   * Deletes a file nothing is using. A file attached to a payment is evidence
   * of that payment and stays; detaching it is the finance module's decision,
   * not a file delete.
   */
  async remove(id: string): Promise<void> {
    const file = await this.getOrThrow(id);
    await this.assertMayUpload(file.purpose);

    if (file.linkedType === 'Payment') {
      throw AppException.conflict(
        'This file is the evidence for a payment and cannot be deleted',
      );
    }

    await this.forget(file);
  }

  /**
   * Replaces whatever was linked here before — a new passport photo means the
   * old one goes, rather than accumulating in the bucket for ever.
   */
  async replaceLinked(
    purpose: FilePurpose,
    link: { type: 'Student' | 'School'; id: string },
    request: IncomingFile,
    schoolId: string,
  ): Promise<FileDto> {
    const uploaded = await this.upload({ ...request, purpose, link }, schoolId);

    const previous = await this.prisma.fileObject.findMany({
      where: {
        purpose,
        linkedType: link.type,
        linkedId: link.id,
        id: { not: uploaded.id },
      },
    });
    for (const file of previous) {
      await this.forget(file);
    }

    return uploaded;
  }

  /** Detaches and deletes whatever is linked, e.g. clearing a photo. */
  async removeLinked(
    purpose: FilePurpose,
    link: { type: 'Student' | 'School'; id: string },
  ): Promise<number> {
    const files = await this.prisma.fileObject.findMany({
      where: { purpose, linkedType: link.type, linkedId: link.id },
    });
    for (const file of files) {
      await this.forget(file);
    }
    return files.length;
  }

  /**
   * Attaches an already-uploaded file to a payment, given the URL a client
   * sent. Returns null when the URL is not one of ours, which leaves the
   * existing behaviour — a link to anywhere — untouched.
   */
  async attachToPayment(
    tx: TxClient,
    evidenceUrl: string | null | undefined,
    paymentId: string,
    studentId: string,
  ): Promise<void> {
    const id = this.idFromUrl(evidenceUrl);
    if (!id) return;

    const file = await tx.fileObject.findUnique({ where: { id } });
    // Another school's file, or another child's, is simply not found.
    if (
      !file ||
      file.purpose !== FilePurpose.PAYMENT_EVIDENCE ||
      (file.linkedType === 'Student' && file.linkedId !== studentId)
    ) {
      throw AppException.badRequest(
        'That evidence file does not belong to this student',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    await tx.fileObject.update({
      where: { id },
      data: { linkedType: 'Payment', linkedId: paymentId },
    });
  }

  /** `/api/files/<uuid>` → the id, or null for anything else. */
  idFromUrl(url: string | null | undefined): string | null {
    const match = /^\/api\/files\/([0-9a-f-]{36})$/i.exec(url ?? '');
    return match ? match[1] : null;
  }

  // ---------------------------------------------------------------------------

  /** Row first, then bytes: a row pointing nowhere is the worse failure. */
  private async forget(file: FileObject): Promise<void> {
    await this.prisma.fileObject.delete({ where: { id: file.id } });
    await this.discard(file.key);
  }

  /**
   * The ceiling in bytes: the school's own override when A4 has set one,
   * otherwise the platform default.
   */
  private async quotaBytes(schoolId: string): Promise<number> {
    const school = await RequestContext.runAsSystem(() =>
      this.prisma.school.findUnique({
        where: { id: schoolId },
        select: { storageQuotaMb: true },
      }),
    );

    const megabytes =
      school?.storageQuotaMb ??
      this.config.get('storage', { infer: true }).quotaMb;

    return megabytes * 1024 * 1024;
  }

  private async assertWithinQuota(
    tx: TxClient,
    schoolId: string,
    incomingBytes: number,
  ): Promise<void> {
    const limitBytes = await this.quotaBytes(schoolId);
    const used = await tx.fileObject.aggregate({ _sum: { sizeBytes: true } });
    const usedBytes = used._sum.sizeBytes ?? 0;

    if (usedBytes + incomingBytes > limitBytes) {
      const limitMb = Math.round(limitBytes / (1024 * 1024));
      throw AppException.conflict(
        `This school has used its ${limitMb} MB of file storage. Delete some ` +
          'files, or ask EduGear to raise the limit.',
        ErrorCode.CONFLICT,
      );
    }
  }

  private async discard(key: string): Promise<void> {
    try {
      await this.storage.driver.delete(key);
    } catch (error) {
      this.logger.warn(
        `Left an orphaned object at ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async getOrThrow(id: string): Promise<FileObject> {
    const file = await this.prisma.fileObject.findUnique({ where: { id } });
    if (!file) throw AppException.notFound('File');
    return file;
  }

  async assertMayUpload(purpose: FilePurpose): Promise<void> {
    const held = await this.permissions();
    if (!held.has(UPLOAD_PERMISSION[purpose])) {
      throw AppException.forbidden(
        `You do not have permission to manage ${purpose.toLowerCase().replace('_', ' ')} files`,
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }
  }

  /**
   * Staff read by permission; a parent reads what belongs to their own child,
   * or what they uploaded themselves. Anything else is reported as missing.
   */
  private async assertMayRead(file: FileObject): Promise<void> {
    const auth = RequestContext.getAuth();
    if (!auth) throw AppException.unauthorized();

    const held = await this.permissions();
    if (held.has(READ_PERMISSION[file.purpose])) return;

    if (held.has(PERMISSIONS.PORTAL_ACCESS)) {
      if (file.uploadedByUserId === auth.userId) return;
      if (file.purpose === FilePurpose.SCHOOL_LOGO) return;
      if (file.linkedType === 'Student' && file.linkedId) {
        const ward = await this.prisma.studentGuardian.findFirst({
          where: {
            studentId: file.linkedId,
            guardian: { userId: auth.userId },
          },
          select: { studentId: true },
        });
        if (ward) return;
      }
    }

    throw AppException.notFound('File');
  }

  private async permissions(): Promise<Set<string>> {
    const auth = RequestContext.getAuth();
    if (!auth) throw AppException.unauthorized();
    const snapshot = await this.accessControl.getMembershipSnapshot(
      auth.membershipId,
    );
    return snapshot?.permissions ?? new Set<string>();
  }

  private toDto(row: FileObject): FileDto {
    return {
      id: row.id,
      purpose: row.purpose,
      url: `/api/files/${row.id}`,
      displayName: row.displayName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      linkedType: row.linkedType,
      linkedId: row.linkedId,
      createdAt: row.createdAt,
    };
  }
}
