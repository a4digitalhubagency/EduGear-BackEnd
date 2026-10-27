import { Controller, Get } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../cache/redis.service';
import { AppConfig } from '../config/configuration';
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
    private readonly config: ConfigService<AppConfig, true>,
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

  /**
   * Liveness, plus which build is answering.
   *
   * "Is the deployment actually running the commit I pushed?" is otherwise a
   * question you can only put to a dashboard, and a dashboard showing a build
   * id next to a commit sha is easy to misread. The running process knows,
   * so it says.
   *
   * The sha is of a private repository, so publishing it gives away nothing
   * actionable — and being able to confirm what is deployed, from outside,
   * without credentials, is worth more than withholding it.
   */
  @Get('live')
  @Public()
  @ApiExcludeEndpoint()
  live() {
    const app = this.config.get('app', { infer: true });
    return {
      status: 'ok',
      uptime: Math.round(process.uptime()),
      // `||`, not `??`: an unresolved platform reference arrives as an empty
      // string, which is not nullish and would be reported as a version.
      environment: process.env.APP_ENV || app.env,
      version: process.env.APP_VERSION || 'unset',
    };
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
