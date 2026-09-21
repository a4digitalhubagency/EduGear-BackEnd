import {
  EmailProvider,
  EnvironmentVariables,
  NodeEnv,
  validateEnv,
} from './env.validation';

/**
 * Shapes validated env vars into a nested, typed config tree.
 * Read it through `ConfigService<AppConfig, true>` — never touch process.env
 * anywhere else in the codebase.
 */
export interface AppConfig {
  app: {
    env: NodeEnv;
    isProduction: boolean;
    isTest: boolean;
    name: string;
    port: number;
    apiPrefix: string;
    url: string;
    frontendUrl: string;
    corsOrigins: string[];
    logLevel: string;
    swaggerEnabled: boolean;
  };
  database: {
    url: string;
    directUrl?: string;
  };
  jwt: {
    accessSecret: string;
    accessTtl: string;
    refreshTtl: string;
    issuer: string;
    audience: string;
  };
  auth: {
    passwordMinLength: number;
    maxFailedLoginAttempts: number;
    accountLockMinutes: number;
    emailVerificationTtlHours: number;
    passwordResetTtlMinutes: number;
    invitationTtlHours: number;
  };
  throttle: {
    ttlSeconds: number;
    limit: number;
    authTtlSeconds: number;
    authLimit: number;
  };
  redis: {
    /** Absent means "run single-instance": in-process throttling and permission cache. */
    url?: string;
    keyPrefix: string;
  };
  email: {
    provider: EmailProvider;
    resendApiKey?: string;
    from: string;
  };
  storage: {
    accountId?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    bucket?: string;
    publicUrl?: string;
    localDir: string;
  };
}

export function buildConfig(env: EnvironmentVariables): AppConfig {
  return {
    app: {
      env: env.NODE_ENV,
      isProduction: env.NODE_ENV === NodeEnv.Production,
      isTest: env.NODE_ENV === NodeEnv.Test,
      name: env.APP_NAME,
      port: env.PORT,
      apiPrefix: env.API_PREFIX,
      url: env.APP_URL,
      frontendUrl: env.FRONTEND_URL,
      corsOrigins: env.CORS_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean),
      logLevel: env.LOG_LEVEL,
      swaggerEnabled: env.SWAGGER_ENABLED,
    },
    database: {
      url: env.DATABASE_URL,
      directUrl: env.DIRECT_URL,
    },
    jwt: {
      accessSecret: env.JWT_ACCESS_SECRET,
      accessTtl: env.JWT_ACCESS_TTL,
      refreshTtl: env.JWT_REFRESH_TTL,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    },
    auth: {
      passwordMinLength: env.PASSWORD_MIN_LENGTH,
      maxFailedLoginAttempts: env.MAX_FAILED_LOGIN_ATTEMPTS,
      accountLockMinutes: env.ACCOUNT_LOCK_MINUTES,
      emailVerificationTtlHours: env.EMAIL_VERIFICATION_TTL_HOURS,
      passwordResetTtlMinutes: env.PASSWORD_RESET_TTL_MINUTES,
      invitationTtlHours: env.INVITATION_TTL_HOURS,
    },
    throttle: {
      ttlSeconds: env.THROTTLE_TTL_SECONDS,
      limit: env.THROTTLE_LIMIT,
      authTtlSeconds: env.AUTH_THROTTLE_TTL_SECONDS,
      authLimit: env.AUTH_THROTTLE_LIMIT,
    },
    redis: {
      url: env.REDIS_URL,
      keyPrefix: env.REDIS_KEY_PREFIX,
    },
    email: {
      provider: env.EMAIL_PROVIDER,
      resendApiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM,
    },
    storage: {
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET,
      publicUrl: env.R2_PUBLIC_URL,
      localDir: env.STORAGE_LOCAL_DIR,
    },
  };
}

/** Loader for ConfigModule. Validation is cheap and pure, so re-running it here is fine. */
export function configFactory(): AppConfig {
  return buildConfig(validateEnv(process.env));
}
