import { Controller, Get } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { RedisService } from '../cache/redis.service';
import { Public } from '../common/decorators';
import { RequestContext } from '../common/context/request-context';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly redis: RedisService,
  ) {}

  @Get()
  @Public()
  @HealthCheck()
  @ApiOperation({ summary: 'Liveness, database and cache readiness probe' })
  check() {
    const indicators = [() => this.checkDatabase()];
    // Only probed when configured: without Redis the app is single-instance by
    // design, and a missing dependency should not be reported as a failure.
    if (this.redis.isEnabled) {
      indicators.push(() => this.checkRedis());
    }
    return this.health.check(indicators);
  }

  @Get('live')
  @Public()
  @ApiExcludeEndpoint()
  live() {
    return { status: 'ok', uptime: process.uptime() };
  }

  private async checkRedis(): Promise<HealthIndicatorResult> {
    const startedAt = Date.now();
    try {
      await this.redis.client!.ping();
      return {
        cache: { status: 'up', responseTimeMs: Date.now() - startedAt },
      };
    } catch (error) {
      return {
        cache: {
          status: 'down',
          message: error instanceof Error ? error.message : 'unreachable',
        },
      };
    }
  }

  private async checkDatabase(): Promise<HealthIndicatorResult> {
    const startedAt = Date.now();
    try {
      // Raw query: no tenant involved, and the guard does not touch $queryRaw.
      await RequestContext.runAsSystem(() => this.prisma.$queryRaw`SELECT 1`);
      return {
        database: { status: 'up', responseTimeMs: Date.now() - startedAt },
      };
    } catch (error) {
      return {
        database: {
          status: 'down',
          message: error instanceof Error ? error.message : 'unreachable',
        },
      };
    }
  }
}
