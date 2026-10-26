// Before every other import: instrumentation has to be in place before the
// modules it watches are loaded.
import { initSentry } from './observability/sentry';
import { EnvironmentConfigError, validateEnv } from './config/env.validation';

/**
 * Misconfiguration is the normal way a first deploy fails, so it gets a clean
 * exit rather than an unhandled throw: a deploy log should open with the list
 * of variables to fix, not with a stack frame in a compiled file.
 */
function readEnvOrExit(): ReturnType<typeof validateEnv> {
  try {
    return validateEnv(process.env);
  } catch (error) {
    if (error instanceof EnvironmentConfigError) {
      process.stderr.write(
        `\nEduGear cannot start: ${error.problems.length} configuration ` +
          `problem${error.problems.length === 1 ? '' : 's'}.\n\n` +
          error.problems.map((p) => `  - ${p}\n`).join('') +
          `\nSet these and deploy again. Full list: .env.example\n\n`,
      );
      process.exit(1);
    }
    throw error;
  }
}

const env = readEnvOrExit();
const sentryEnabled = initSentry(env);

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { applyHttpSettings } from './http-settings';
import { QuietBootLogger } from './observability/quiet-boot-logger';
import { flushSentry } from './observability/sentry';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  const config = app.get(ConfigService<AppConfig, true>);
  const appConfig = config.get('app', { infer: true });

  // Nest's start-up narration is 236 of the 247 lines this logs at boot. Past a
  // platform's log rate limit the overflow is dropped, taking any crash with
  // it, so production keeps the 11 that mean something.
  const logger = app.get(Logger);
  app.useLogger(appConfig.isProduction ? new QuietBootLogger(logger) : logger);
  app.flushLogs();

  applyHttpSettings(app, appConfig.apiPrefix);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  app.enableCors({
    origin: appConfig.corsOrigins.includes('*') ? true : appConfig.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  });

  app.enableShutdownHooks();
  if (sentryEnabled) {
    // Shutdown hooks close the app; a report generated on the way out still has
    // to reach Sentry before the process goes.
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => void flushSentry());
    }
  }

  if (appConfig.swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('EduGear API')
        .setDescription(
          'Multi-tenant school management API. Every request is scoped to the school ' +
            'derived from the access token — tenant ids are never accepted from clients.',
        )
        .setVersion('0.1.0')
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', in: 'header' },
          'bearer',
        )
        .addTag('Authentication')
        .addTag('School')
        .addTag('Users')
        .addTag('Academics')
        .addTag('Students')
        .addTag('Guardians')
        .addTag('Finance')
        .addTag('Results')
        .addTag('Attendance')
        .addTag('Files')
        .addTag('Parent Portal')
        .addTag('Audit')
        .addTag('Health')
        .build(),
    );

    SwaggerModule.setup(`${appConfig.apiPrefix}/docs`, app, document, {
      swaggerOptions: { persistAuthorization: true },
      jsonDocumentUrl: `${appConfig.apiPrefix}/docs-json`,
    });
  }

  await app.listen(appConfig.port, '0.0.0.0');

  if (!sentryEnabled && appConfig.isProduction) {
    // Not fatal — an unreported error is better than no service — but a school
    // should never be the one who tells you the API is failing.
    app
      .get(Logger)
      .warn(
        'SENTRY_DSN is not set: errors will only reach the container logs.',
      );
  }
}

void bootstrap();
