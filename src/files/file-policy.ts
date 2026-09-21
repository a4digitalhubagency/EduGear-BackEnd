import { FilePurpose } from '@prisma/client';

/**
 * What may be uploaded, and how it is checked.
 *
 * A browser's declared content type is a claim by the client, so it decides
 * nothing here: the bytes are read and must match one of the kinds the purpose
 * allows. That is what stops an executable arriving as "photo.jpg", and it is
 * why uploads pass through the API rather than going straight to storage.
 */
export interface FileKind {
  contentType: string;
  extension: string;
  /** Leading bytes every file of this kind starts with. */
  signature: readonly (number | null)[];
  /** Extra check for containers whose signature is split, like WebP. */
  verify?: (buffer: Buffer) => boolean;
}

const JPEG: FileKind = {
  contentType: 'image/jpeg',
  extension: 'jpg',
  signature: [0xff, 0xd8, 0xff],
};
const PNG: FileKind = {
  contentType: 'image/png',
  extension: 'png',
  signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};
const WEBP: FileKind = {
  contentType: 'image/webp',
  extension: 'webp',
  // "RIFF" then four size bytes then "WEBP".
  signature: [
    0x52,
    0x49,
    0x46,
    0x46,
    null,
    null,
    null,
    null,
    0x57,
    0x45,
    0x42,
    0x50,
  ],
};
const PDF: FileKind = {
  contentType: 'application/pdf',
  extension: 'pdf',
  signature: [0x25, 0x50, 0x44, 0x46, 0x2d],
};

export const FILE_KINDS: readonly FileKind[] = [JPEG, PNG, WEBP, PDF];

export interface PurposePolicy {
  kinds: readonly FileKind[];
  maxBytes: number;
  /** Shown in messages, so a registrar knows what to send instead. */
  label: string;
}

const MB = 1024 * 1024;

export const FILE_POLICIES: Record<FilePurpose, PurposePolicy> = {
  STUDENT_PHOTO: {
    kinds: [JPEG, PNG, WEBP],
    maxBytes: 5 * MB,
    label: 'a JPEG, PNG or WebP image',
  },
  SCHOOL_LOGO: {
    kinds: [JPEG, PNG, WEBP],
    maxBytes: 2 * MB,
    label: 'a JPEG, PNG or WebP image',
  },
  PAYMENT_EVIDENCE: {
    kinds: [JPEG, PNG, WEBP, PDF],
    maxBytes: 10 * MB,
    label: 'a photo of the teller or a PDF',
  },
};

/** The largest upload any purpose allows — the multipart limit. */
export const MAX_UPLOAD_BYTES = Math.max(
  ...Object.values(FILE_POLICIES).map((policy) => policy.maxBytes),
);

export function matchesSignature(buffer: Buffer, kind: FileKind): boolean {
  if (buffer.length < kind.signature.length) return false;
  return kind.signature.every(
    (byte, index) => byte === null || buffer[index] === byte,
  );
}

/** The kind these bytes actually are, whatever the upload claimed. */
export function detectKind(buffer: Buffer): FileKind | null {
  return FILE_KINDS.find((kind) => matchesSignature(buffer, kind)) ?? null;
}

export interface FileCheck {
  ok: boolean;
  kind?: FileKind;
  error?: string;
}

/** Everything a stored file must satisfy, in the order a person would check it. */
export function checkFile(
  buffer: Buffer,
  purpose: FilePurpose,
  declaredType?: string,
): FileCheck {
  const policy = FILE_POLICIES[purpose];

  if (buffer.length === 0) {
    return { ok: false, error: 'The file is empty' };
  }
  if (buffer.length > policy.maxBytes) {
    return {
      ok: false,
      error: `The file is ${formatBytes(buffer.length)}; the limit is ${formatBytes(policy.maxBytes)}`,
    };
  }

  const kind = detectKind(buffer);
  if (!kind) {
    return { ok: false, error: `Unrecognised file. Send ${policy.label}.` };
  }
  if (!policy.kinds.includes(kind)) {
    return {
      ok: false,
      error: `${kind.contentType} is not accepted here. Send ${policy.label}.`,
    };
  }
  // The claim is only worth reporting when it disagrees with the bytes.
  if (declaredType && normaliseType(declaredType) !== kind.contentType) {
    return {
      ok: false,
      error: `This was sent as ${normaliseType(declaredType)} but is really ${kind.contentType}`,
    };
  }

  return { ok: true, kind };
}

function normaliseType(value: string): string {
  const bare = value.split(';')[0].trim().toLowerCase();
  // Browsers still send these older spellings for JPEG.
  return bare === 'image/jpg' || bare === 'image/pjpeg' ? 'image/jpeg' : bare;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / MB) * 10) / 10} MB`;
}

/**
 * A display name safe to store and to put in a Content-Disposition header.
 *
 * The stored key never uses this — keys are built from a UUID — so this is
 * about what a person sees, not where bytes land. Directory separators, control
 * characters and quotes are removed anyway: a name like "../../etc/passwd"
 * should never be echoed back as though it were a path.
 */
export function safeDisplayName(
  raw: string | undefined,
  extension: string,
): string {
  // Control characters go first — a newline in a filename would break the
  // Content-Disposition header — checked by code point rather than by regex.
  const printable = [...(raw ?? '')]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('');

  const base = printable
    // Separators and dot runs go entirely, rather than collapsing into dots
    // that still read like a path.
    .replace(/[\\/]/g, ' ')
    .replace(/\.{2,}/g, '')
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const withoutExtension = base.replace(/\.[A-Za-z0-9]{1,8}$/, '').trim();
  const cleaned = withoutExtension
    .slice(0, 80)
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();

  return cleaned ? `${cleaned}.${extension}` : `upload.${extension}`;
}

/** Storage key: tenant first, then purpose, then an unguessable name. */
export function storageKey(
  schoolId: string,
  purpose: FilePurpose,
  id: string,
  extension: string,
): string {
  return `schools/${schoolId}/${purpose.toLowerCase()}/${id}.${extension}`;
}
