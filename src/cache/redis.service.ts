import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AppConfig } from '../config/configuration';

/**
 * The single shared Redis connection.
 *
 * `client` is null when `REDIS_URL` is unset, which is legitimate for local
 * development, tests and CI — callers then fall back to in-process state.
 * Production refuses to boot without it (see `env.validation.ts`), so the
 * fallback can never be reached by accident on a deployed instance.
 *
 * Keys are namespaced by the caller rather than by ioredis' `keyPrefix`, because
 * the throttler storage adapter passes keys to a Lua script and client-level
 * prefixing there is easy to get subtly wrong.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis | null;
  readonly keyPrefix: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const redis = config.get('redis', { infer: true });
    this.keyPrefix = redis.keyPrefix;

    if (!redis.url) {
      this.client = null;
      this.logger.warn(
        'REDIS_URL is not set — rate limiting and the permission cache are ' +
          'per-instance. Correct for a single instance only.',
      );
      return;
    }

    this.client = new Redis(redis.url, {
      // Fail a command rather than queueing forever when Redis is unreachable:
      // a slow 500 is easier to diagnose than a hung request.
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    });

    // 'error' must be handled or ioredis emits an unhandled error event.
    this.client.on('error', (error: Error) =>
      this.logger.error(`Redis connection error: ${error.message}`),
    );
    this.client.on('ready', () => this.logger.log('Redis connection ready'));
  }

  get isEnabled(): boolean {
    return this.client !== null;
  }

  /** Namespaced key. Every EduGear key goes through here. */
  key(...parts: string[]): string {
    return `${this.keyPrefix}${parts.join(':')}`;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit();
    }
  }
}
