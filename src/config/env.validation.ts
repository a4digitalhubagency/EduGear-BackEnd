import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
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

/** The deployment, as opposed to the Node mode. */
export enum AppEnv {
  Development = 'development',
  Staging = 'staging',
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

const toFloat = ({ value }: { value: unknown }) => {
  const raw = asString(value);
  return raw === undefined || raw === '' ? undefined : Number.parseFloat(raw);
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

  /// Paystack secret key. Online payments are off until it is set.
  @IsString()
  @IsOptional()
  PAYSTACK_SECRET_KEY?: string;

  /// Where Paystack sends the payer back once they have finished.
  @IsUrl({ require_tld: false })
  @IsOptional()
  PAYSTACK_CALLBACK_URL?: string;

  /// Where uploads go when R2 is not configured. Development and tests only.
  @IsString()
  STORAGE_LOCAL_DIR = 'storage';

  /// Default upload ceiling per school, in megabytes. A school cannot raise its
  /// own; A4 lifts it per tenant from the platform console.
  @IsInt()
  @Min(1)
  @Transform(toInt)
  STORAGE_QUOTA_MB = 2048;

  // Optional so local development and CI can run without Redis; required in
  // production, where falling back to per-instance state would be silent breakage.
  @IsString()
  @IsOptional()
  REDIS_URL?: string;

  /** Namespaces every EduGear key so a shared Redis can host other tenants of the box. */
  @IsString()
  REDIS_KEY_PREFIX = 'edugear:';

  /// Error reporting. Absent means errors stay in the logs, which is correct for
  /// local development and wrong for production — a school should not be the one
  /// who tells you the API is failing.
  @IsString()
  @IsOptional()
  SENTRY_DSN?: string;

  @IsNumber()
  @Min(0)
  @Max(1)
  @Transform(toFloat)
  SENTRY_TRACES_SAMPLE_RATE = 0.1;

  /// Which deployment this is. Separate from NODE_ENV because staging runs with
  /// NODE_ENV=production on purpose — so that it behaves like production — and
  /// everything that must still tell the two apart keys off this instead:
  /// Sentry's environment, and whether seeding is allowed.
  @IsEnum(AppEnv)
  @IsOptional()
  APP_ENV?: AppEnv;

  /// Ties an error to the commit that caused it. Railway exposes the deployed
  /// SHA, so this is set from it rather than maintained by hand.
  @IsString()
  @IsOptional()
  APP_VERSION?: string;
}

/**
 * Validates the environment and reports **everything** that is wrong at once.
 *
 * This used to throw at the first problem, which meant a deploy told you about
 * DATABASE_URL, and only after you fixed it and waited for another build did it
 * mention REDIS_URL. Four sequential checks meant up to four deploy cycles to
 * learn what a single pass already knew.
 */
export function validateEnv(
  raw: Record<string, unknown>,
): EnvironmentVariables {
  const config = plainToInstance(EnvironmentVariables, raw, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });

  const problems = validateSync(config, {
    skipMissingProperties: false,
    whitelist: false,
  }).map(
    (e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
  );

  // A connection string whose value still carries its own key name — the shape
  // you get from pasting a KEY=value block into a dashboard's value field —
  // passes every check above, because it is a perfectly good non-empty string.
  // It then fails at connect time: Redis as a log line and a silently
  // cacheless production, Postgres as a crash much later. Catch the shape.
  for (const [key, value, schemes] of [
    ['DATABASE_URL', config.DATABASE_URL, ['postgresql://', 'postgres://']],
    ['DIRECT_URL', config.DIRECT_URL, ['postgresql://', 'postgres://']],
    ['REDIS_URL', config.REDIS_URL, ['redis://', 'rediss://']],
  ] as const) {
    if (!value) continue;
    if (!schemes.some((scheme) => value.startsWith(scheme))) {
      const looksPasted = value.startsWith(`${key}=`);
      problems.push(
        looksPasted
          ? `${key}: the value starts with "${key}=" — paste the connection string only, not the whole line`
          : `${key}: must start with ${schemes.join(' or ')}`,
      );
    }
  }

  if (config.EMAIL_PROVIDER === EmailProvider.Resend) {
    if (!config.RESEND_API_KEY) {
      problems.push('RESEND_API_KEY: required when EMAIL_PROVIDER=resend');
    }
    // Invitation, verification and reset emails are built as
    // `${FRONTEND_URL}/accept-invitation?token=…`. Sending those for real while
    // FRONTEND_URL is still the development default means posting a parent a
    // link to their own machine.
    if (
      /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(config.FRONTEND_URL ?? '')
    ) {
      problems.push(
        'FRONTEND_URL: still points at localhost while EMAIL_PROVIDER=resend — ' +
          'every invitation and password-reset link would be unusable',
      );
    }
  }

  // Evaluated even when the checks above failed, so one pass reports the lot.
  // Each guard tolerates a missing value, because that is already reported.
  if (config.NODE_ENV === NodeEnv.Production) {
    if (config.CORS_ORIGINS?.trim() === '*') {
      problems.push('CORS_ORIGINS: "*" is not allowed in production');
    }
    if (config.JWT_ACCESS_SECRET?.includes('replace-me')) {
      problems.push('JWT_ACCESS_SECRET: still holds the placeholder value');
    }
    if (!config.REDIS_URL) {
      problems.push(
        'REDIS_URL: required in production — without it, rate limiting and the ' +
          'permission cache are per-instance, so a second instance would ' +
          'silently weaken both',
      );
    }
  }

  if (problems.length > 0) {
    throw new EnvironmentConfigError(problems);
  }

  return config;
}

/**
 * Carries the whole list so the entry point can print it without a stack trace.
 * A deploy log should lead with what to fix, not with a frame from a compiled
 * file nobody is going to open.
 */
export class EnvironmentConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `Invalid environment configuration:\n${problems
        .map((p) => `  - ${p}`)
        .join('\n')}`,
    );
    this.name = 'EnvironmentConfigError';
  }
}
