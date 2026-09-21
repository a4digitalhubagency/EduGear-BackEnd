import { FilePurpose } from '@prisma/client';
import {
  checkFile,
  detectKind,
  formatBytes,
  safeDisplayName,
  storageKey,
} from './file-policy';

/** Real leading bytes for each kind, padded so the file is not trivially tiny. */
const bytes = {
  jpeg: Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(100),
  ]),
  png: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(100),
  ]),
  webp: Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP'),
    Buffer.alloc(100),
  ]),
  pdf: Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(100)]),
  /** An ELF executable, the thing a photo upload must never accept. */
  elf: Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.alloc(100),
  ]),
  html: Buffer.from('<html><script>alert(1)</script></html>'),
};

describe('detectKind', () => {
  it.each([
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['webp', 'image/webp'],
    ['pdf', 'application/pdf'],
  ] as const)('recognises %s from its bytes', (key, contentType) => {
    expect(detectKind(bytes[key])?.contentType).toBe(contentType);
  });

  it('recognises nothing in an executable or a web page', () => {
    expect(detectKind(bytes.elf)).toBeNull();
    expect(detectKind(bytes.html)).toBeNull();
  });

  it('does not mistake any RIFF container for WebP', () => {
    // A WAV file: RIFF, then "WAVE" where WebP would say "WEBP".
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE'),
      Buffer.alloc(50),
    ]);
    expect(detectKind(wav)).toBeNull();
  });

  it('is not fooled by a signature appearing later in the file', () => {
    const buried = Buffer.concat([Buffer.from('not an image'), bytes.png]);
    expect(detectKind(buried)).toBeNull();
  });

  it('handles a file shorter than a signature', () => {
    expect(detectKind(Buffer.from([0xff]))).toBeNull();
    expect(detectKind(Buffer.alloc(0))).toBeNull();
  });
});

describe('checkFile', () => {
  it('accepts a real photo for a student photo', () => {
    expect(
      checkFile(bytes.jpeg, FilePurpose.STUDENT_PHOTO, 'image/jpeg'),
    ).toMatchObject({
      ok: true,
    });
  });

  it('refuses an executable renamed as a photo', () => {
    const result = checkFile(
      bytes.elf,
      FilePurpose.STUDENT_PHOTO,
      'image/jpeg',
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unrecognised file/);
  });

  it('refuses a PDF as a student photo but accepts it as payment evidence', () => {
    expect(
      checkFile(bytes.pdf, FilePurpose.STUDENT_PHOTO, 'application/pdf').ok,
    ).toBe(false);
    expect(
      checkFile(bytes.pdf, FilePurpose.PAYMENT_EVIDENCE, 'application/pdf').ok,
    ).toBe(true);
  });

  it('refuses bytes that disagree with what was declared', () => {
    const result = checkFile(
      bytes.png,
      FilePurpose.STUDENT_PHOTO,
      'image/jpeg',
    );
    expect(result.error).toBe(
      'This was sent as image/jpeg but is really image/png',
    );
  });

  it('accepts the older spellings browsers still send for JPEG', () => {
    expect(
      checkFile(bytes.jpeg, FilePurpose.STUDENT_PHOTO, 'image/jpg').ok,
    ).toBe(true);
    expect(
      checkFile(
        bytes.jpeg,
        FilePurpose.STUDENT_PHOTO,
        'image/jpeg; charset=binary',
      ).ok,
    ).toBe(true);
  });

  it('judges by the bytes when nothing was declared', () => {
    expect(checkFile(bytes.jpeg, FilePurpose.STUDENT_PHOTO).ok).toBe(true);
  });

  it('refuses an empty file', () => {
    expect(checkFile(Buffer.alloc(0), FilePurpose.STUDENT_PHOTO).error).toBe(
      'The file is empty',
    );
  });

  it('refuses a file over the purpose’s limit, saying both sizes', () => {
    const huge = Buffer.concat([bytes.jpeg, Buffer.alloc(6 * 1024 * 1024)]);
    const result = checkFile(huge, FilePurpose.STUDENT_PHOTO, 'image/jpeg');
    expect(result.error).toMatch(/^The file is 6 MB; the limit is 5 MB$/);
  });

  it('allows a bigger file for payment evidence than for a photo', () => {
    const seven = Buffer.concat([bytes.jpeg, Buffer.alloc(7 * 1024 * 1024)]);
    expect(checkFile(seven, FilePurpose.STUDENT_PHOTO, 'image/jpeg').ok).toBe(
      false,
    );
    expect(
      checkFile(seven, FilePurpose.PAYMENT_EVIDENCE, 'image/jpeg').ok,
    ).toBe(true);
  });
});

describe('safeDisplayName', () => {
  it('keeps an ordinary name and fixes the extension', () => {
    expect(safeDisplayName('ada-passport.JPG', 'jpg')).toBe('ada-passport.jpg');
  });

  it('strips anything that looks like a path', () => {
    expect(safeDisplayName('../../etc/passwd', 'pdf')).toBe('etc passwd.pdf');
    expect(safeDisplayName('C:\\Users\\me\\teller.pdf', 'pdf')).toBe(
      'C: Users me teller.pdf',
    );
  });

  it('removes control characters and quotes that break a header', () => {
    // The bogus ".sh" is treated as an extension and replaced by the real one.
    expect(safeDisplayName('recei\npt"; filename="evil.sh', 'pdf')).toBe(
      'receipt; filename=evil.pdf',
    );
  });

  it('keeps names in other scripts', () => {
    expect(safeDisplayName('Adaeze Chukwu — passport.png', 'png')).toBe(
      'Adaeze Chukwu — passport.png',
    );
  });

  it('shortens a very long name', () => {
    const name = safeDisplayName('a'.repeat(300), 'jpg');
    expect(name.length).toBeLessThanOrEqual(84);
    expect(name.endsWith('.jpg')).toBe(true);
  });

  it('falls back when there is no usable name', () => {
    expect(safeDisplayName(undefined, 'jpg')).toBe('upload.jpg');
    expect(safeDisplayName('   ', 'jpg')).toBe('upload.jpg');
    expect(safeDisplayName('.jpg', 'jpg')).toBe('upload.jpg');
  });
});

describe('storageKey', () => {
  it('puts the tenant first and never uses the uploader’s name', () => {
    expect(
      storageKey('school-1', FilePurpose.STUDENT_PHOTO, 'file-1', 'jpg'),
    ).toBe('schools/school-1/student_photo/file-1.jpg');
  });
});

describe('formatBytes', () => {
  it.each([
    [512, '512 B'],
    [2048, '2 KB'],
    [5 * 1024 * 1024, '5 MB'],
  ])('%p → %p', (value, expected) => {
    expect(formatBytes(value)).toBe(expected);
  });
});
