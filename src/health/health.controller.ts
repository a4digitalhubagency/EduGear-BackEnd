import { Controller, Get } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
} from '@nestjs/terminus';
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
  ) {}

  @Get()
  @Public()
  @HealthCheck()
  @ApiOperation({ summary: 'Liveness and database readiness probe' })
  check() {
    return this.health.check([() => this.checkDatabase()]);
  }

  @Get('live')
  @Public()
  @ApiExcludeEndpoint()
  live() {
    return { status: 'ok', uptime: process.uptime() };
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
