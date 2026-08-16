import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { AppConfig } from '../config/configuration';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';

/**
 * argon2id with OWASP-recommended parameters. Plaintext passwords are never
 * stored, logged, or included in audit metadata.
 */
@Injectable()
export class PasswordService {
  private readonly options: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 19_456, // 19 MiB
    timeCost: 2,
    parallelism: 1,
  };

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, this.options);
  }

  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      // Corrupt or legacy hash — treat as a failed attempt, never as success.
      return false;
    }
  }

  /** Server-side policy check. DTO validation covers shape; this covers substance. */
  assertMeetsPolicy(password: string): void {
    const { passwordMinLength } = this.config.get('auth', { infer: true });
    const problems: string[] = [];

    if (password.length < passwordMinLength) {
      problems.push(`must be at least ${passwordMinLength} characters`);
    }
    if (!/[a-zA-Z]/.test(password)) {
      problems.push('must contain a letter');
    }
    if (!/\d/.test(password)) {
      problems.push('must contain a number');
    }
    if (PasswordService.isTooCommon(password)) {
      problems.push('is too common — choose something harder to guess');
    }

    if (problems.length > 0) {
      throw new AppException(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Password is too weak',
        [{ field: 'password', constraints: problems }],
      );
    }
  }

  /**
   * A deliberately small blocklist of the passwords that actually show up in
   * credential-stuffing lists, plus product-specific guesses. Not a substitute
   * for rate limiting and lockout — a cheap complement to them.
   */
  private static readonly COMMON_FRAGMENTS = [
    'password',
    'passw0rd',
    '12345678',
    '87654321',
    'qwerty',
    'iloveyou',
    'admin123',
    'welcome1',
    'letmein',
    'abc12345',
    'edugear',
    'school123',
    'teacher1',
  ];

  private static isTooCommon(password: string): boolean {
    const normalised = password.toLowerCase();
    if (
      PasswordService.COMMON_FRAGMENTS.some((fragment) =>
        normalised.includes(fragment),
      )
    ) {
      return true;
    }
    // Single repeated character, e.g. "aaaaaaaaaa1".
    return /^(.)\1+\d*$/.test(normalised);
  }
}
