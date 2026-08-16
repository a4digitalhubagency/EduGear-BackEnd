import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { AppConfig } from '../config/configuration';
import { tenantGuardExtension } from './tenant-guard.extension';

/**
 * Raw Prisma client. Intentionally NOT exported from PrismaModule — application
 * code injects the tenant-guarded client (`PRISMA` token) instead, so an
 * unscoped query cannot be written by accident.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<AppConfig, true>) {
    const app = config.get('app', { infer: true });
    const database = config.get('database', { infer: true });

    super({
      datasources: { db: { url: database.url } },
      log: app.isProduction
        ? [
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ]
        : [
            { emit: 'event', level: 'query' },
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ],
    });

    if (!app.isProduction) {
      // Slow-query visibility in development without console.log littered around.
      (this as PrismaClient).$on(
        'query' as never,
        (event: { query: string; duration: number }) => {
          if (event.duration >= 200) {
            this.logger.debug(`slow query ${event.duration}ms: ${event.query}`);
          }
        },
      );
    }

    (this as PrismaClient).$on('warn' as never, (event: { message: string }) =>
      this.logger.warn(event.message),
    );
    (this as PrismaClient).$on('error' as never, (event: { message: string }) =>
      this.logger.error(event.message),
    );
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

/** Wraps a raw client with the tenant guard. Context comes from AsyncLocalStorage,
 *  so a single extended client serves every request. */
export function extendWithTenantGuard(base: PrismaClient) {
  return base.$extends(tenantGuardExtension());
}

/** The client every service should depend on. */
export type TenantAwarePrisma = ReturnType<typeof extendWithTenantGuard>;

/** The client handed to a `$transaction` callback — same guarded model surface. */
export type TxClient = Omit<
  TenantAwarePrisma,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
