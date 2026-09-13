import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { applyHttpSettings } from './http-settings';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  const config = app.get(ConfigService<AppConfig, true>);
  const appConfig = config.get('app', { infer: true });

  app.useLogger(app.get(Logger));
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
}

void bootstrap();
