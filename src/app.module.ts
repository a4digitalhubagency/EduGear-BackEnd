import {
  MiddlewareConsumer,
  Module,
  NestModule,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { LoggerModule } from 'nestjs-pino';
import { RedisModule } from './cache/redis.module';
import { RedisService } from './cache/redis.service';
import { AcademicsModule } from './academics/academics.module';
import { AttendanceModule } from './attendance/attendance.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { RequestContext } from './common/context/request-context';
import { AppConfigModule } from './config/config.module';
import { AppConfig } from './config/configuration';
import { PrismaModule } from './database/prisma.module';
import { HealthModule } from './health/health.module';
import { NotificationsModule } from './notifications/notifications.module';
import { TenantsModule } from './tenants/tenants.module';
import { FilesModule } from './files/files.module';
import { FinanceModule } from './finance/finance.module';
import { GuardiansModule } from './guardians/guardians.module';
import { PortalModule } from './portal/portal.module';
import { ResultsModule } from './results/results.module';
import { StudentsModule } from './students/students.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    AppConfigModule,

    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const app = config.get('app', { infer: true });
        return {
          pinoHttp: {
            level: app.logLevel,
            // Every log line carries request/user/tenant so an incident can be traced.
            customProps: () => {
              const auth = RequestContext.getAuth();
              return {
                requestId: RequestContext.getRequestId(),
                userId: auth?.userId,
                schoolId: auth?.schoolId,
              };
            },
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.password',
                'req.body.newPassword',
                'req.body.currentPassword',
                'req.body.token',
                'req.body.refreshToken',
                'res.headers["set-cookie"]',
              ],
              censor: '[redacted]',
            },
            autoLogging: {
              ignore: (req) =>
                req.url === '/api/health' || req.url === '/api/health/live',
            },
            transport: app.isProduction
              ? undefined
              : {
                  target: 'pino-pretty',
                  options: { singleLine: true, colorize: true },
                },
          },
        };
      },
    }),

    ThrottlerModule.forRootAsync({
      // Explicit despite RedisModule being global: this factory runs during
      // module resolution, so the dependency should not rely on ordering.
      imports: [RedisModule],
      inject: [ConfigService, RedisService],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        redis: RedisService,
      ) => {
        const throttle = config.get('throttle', { infer: true });
        return {
          throttlers: [
            { ttl: throttle.ttlSeconds * 1000, limit: throttle.limit },
          ],
          // Shared storage means one budget across every instance. Without Redis
          // the default in-memory storage applies, i.e. a per-instance budget —
          // production refuses to boot in that state.
          storage: redis.client
            ? new ThrottlerStorageRedisService(redis.client)
            : undefined,
        };
      },
    }),

    RedisModule,
    PrismaModule,
    FilesModule,
    NotificationsModule,
    AuditModule,
    AuthModule,
    TenantsModule,
    UsersModule,
    AcademicsModule,
    StudentsModule,
    GuardiansModule,
    FinanceModule,
    ResultsModule,
    AttendanceModule,
    PortalModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
        stopAtFirstError: false,
      }),
    },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Order matters: rate limit, then authenticate, then authorize.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Runs before guards, so the JWT strategy can attach the tenant to this context.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
