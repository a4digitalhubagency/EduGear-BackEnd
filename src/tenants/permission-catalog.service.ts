import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { RequestContext } from '../common/context/request-context';
import {
  ALL_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  permissionGroup,
} from '../common/constants/permissions';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';

/**
 * The permission catalogue lives in code and is mirrored into the database on
 * boot. That keeps a deployed environment from drifting behind a release that
 * introduced new permissions, without anyone remembering to run a seed script.
 */
@Injectable()
export class PermissionCatalogService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PermissionCatalogService.name);

  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.sync();
  }

  async sync(): Promise<void> {
    // Permission is a global (non-tenant) model, but be explicit about intent.
    await RequestContext.runAsSystem(async () => {
      for (const key of ALL_PERMISSIONS) {
        await this.prisma.permission.upsert({
          where: { key },
          create: {
            key,
            group: permissionGroup(key),
            description: PERMISSION_DESCRIPTIONS[key],
          },
          update: {
            group: permissionGroup(key),
            description: PERMISSION_DESCRIPTIONS[key],
          },
        });
      }
    });

    this.logger.log(
      `Permission catalogue synced (${ALL_PERMISSIONS.length} permissions)`,
    );
  }
}
