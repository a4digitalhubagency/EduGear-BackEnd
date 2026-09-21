import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';
import { Transform } from 'class-transformer';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export enum EmailProvider {
  /// Logs the email instead of sending it — the default for local development.
  Console = 'console',
  Resend = 'resend',
}

/** Env vars arrive as strings; anything else is a programming error, not input. */
const asString = (value: unknown): string | undefined =>
  typeof value === 'string'
    ? value
    : typeof value === 'number'
      ? String(value)
      : undefined;

const toInt = ({ value }: { value: unknown }) => {
  const raw = asString(value);
  return raw === undefined || raw === '' ? undefined : Number.parseInt(raw, 10);
};

const toBool = ({ value }: { value: unknown }) => {
  const raw = asString(value);
  return raw === undefined || raw === ''
    ? undefined
    : raw.toLowerCase() === 'true';
};

/**
 * Fail fast on boot rather than blowing up on the first request that needs a
 * missing variable. Anything without a default here is genuinely required.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(1)
  @Max(65535)
  @Transform(toInt)
  PORT = 3000;

  @IsString()
  API_PREFIX = 'api';

  @IsString()
  APP_NAME = 'EduGear';

  @IsUrl({ require_tld: false })
  APP_URL = 'http://localhost:3000';

  @IsUrl({ require_tld: false })
  FRONTEND_URL = 'http://localhost:5173';

  @IsString()
  CORS_ORIGINS = 'http://localhost:5173';

  @IsString()
  LOG_LEVEL = 'info';

  @IsBoolean()
  @Transform(toBool)
  SWAGGER_ENABLED = true;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  @IsString()
  @IsOptional()
  DIRECT_URL?: string;

  @IsString()
  @IsOptional()
  TEST_DATABASE_URL?: string;

  // A short secret is the single most common way a JWT setup gets broken.
  @IsString()
  @MinLength(32, {
    message: 'JWT_ACCESS_SECRET must be at least 32 characters',
  })
  JWT_ACCESS_SECRET: string;

  @IsString()
  JWT_ACCESS_TTL = '15m';

  @IsString()
  JWT_REFRESH_TTL = '30d';

  @IsString()
  JWT_ISSUER = 'edugear';

  @IsString()
  JWT_AUDIENCE = 'edugear-api';

  @IsInt()
  @Min(8)
  @Transform(toInt)
  PASSWORD_MIN_LENGTH = 10;

  @IsInt()
  @Min(1)
  @Transform(toInt)
  MAX_FAILED_LOGIN_ATTEMPTS = 5;

  @IsInt()
  @Min(1)
  @Transform(toInt)
  ACCOUNT_LOCK_MINUTES = 15;

  @IsInt()
  @Min(1)
  @Transform(toInt)
  EMAIL_VERIFICATION_TTL_HOURS = 48;

  @IsInt()
  @Min(1)
  @Transform(toInt)
  PASSWORD_RESET_TTL_MINUTES = 60;

  @IsInt()
  @Min(1)
  @Transform(toInt)
  INVITATION_TTL_HOURS = 168;

  @IsInt()
  @Min(1)
  @Transform(toInt)
  THROTTLE_TTL_SECONDS = 60;

  @IsInt()
  @Min(1)
  @Transform(toInt)
  THROTTLE_LIMIT = 120;

  @IsInt()
  @Min(1)
  @Transform(toInt)
  AUTH_THROTTLE_TTL_SECONDS = 60;

  @IsInt()
  @Min(1)
  @Transform(toInt)
  AUTH_THROTTLE_LIMIT = 10;

  @IsInt()
  @Min(1)
  @Transform(toInt)
  STRICT_THROTTLE_TTL_SECONDS = 3600;

  @IsInt()
  @Min(1)
  @Transform(toInt)
  STRICT_THROTTLE_LIMIT = 5;

  @IsEnum(EmailProvider)
  EMAIL_PROVIDER: EmailProvider = EmailProvider.Console;

  @IsString()
  @IsOptional()
  RESEND_API_KEY?: string;

  @IsString()
  EMAIL_FROM = 'EduGear <no-reply@edugear.app>';

  @IsString()
  @IsOptional()
  R2_ACCOUNT_ID?: string;

  @IsString()
  @IsOptional()
  R2_ACCESS_KEY_ID?: string;

  @IsString()
  @IsOptional()
  R2_SECRET_ACCESS_KEY?: string;

  @IsString()
  @IsOptional()
  R2_BUCKET?: string;

  @IsString()
  @IsOptional()
  R2_PUBLIC_URL?: string;

  /// Where uploads go when R2 is not configured. Development and tests only.
  @IsString()
  STORAGE_LOCAL_DIR = 'storage';

  // Optional so local development and CI can run without Redis; required in
  // production, where falling back to per-instance state would be silent breakage.
  @IsString()
  @IsOptional()
  REDIS_URL?: string;

  /** Namespaces every EduGear key so a shared Redis can host other tenants of the box. */
  @IsString()
  REDIS_KEY_PREFIX = 'edugear:';
}

export function validateEnv(
  raw: Record<string, unknown>,
): EnvironmentVariables {
  const config = plainToInstance(EnvironmentVariables, raw, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });

  const errors = validateSync(config, {
    skipMissingProperties: false,
    whitelist: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map(
        (e) =>
          `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
      )
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  if (
    config.EMAIL_PROVIDER === EmailProvider.Resend &&
    !config.RESEND_API_KEY
  ) {
    throw new Error('EMAIL_PROVIDER=resend requires RESEND_API_KEY to be set');
  }

  if (config.NODE_ENV === NodeEnv.Production) {
    if (config.CORS_ORIGINS.trim() === '*') {
      throw new Error('CORS_ORIGINS=* is not allowed in production');
    }
    if (config.JWT_ACCESS_SECRET.includes('replace-me')) {
      throw new Error('JWT_ACCESS_SECRET still holds the placeholder value');
    }
    if (!config.REDIS_URL) {
      throw new Error(
        'REDIS_URL is required in production: without it, rate limiting and the ' +
          'permission cache are per-instance, so a second instance would silently ' +
          'weaken both.',
      );
    }
  }

  return config;
}
