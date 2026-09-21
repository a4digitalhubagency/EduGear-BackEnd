import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'node:path';
import { AppConfig } from '../../config/configuration';
import { LocalStorageDriver } from './local-storage.driver';
import { R2StorageDriver } from './r2-storage.driver';
import { StorageDriver } from './storage.driver';

/**
 * Chooses where files go.
 *
 * R2 when it is configured; otherwise the local disk, which is right for
 * development and tests. Production without R2 is the one combination that is
 * refused at the point of upload rather than at boot: the rest of the system
 * works perfectly well without file uploads, and a deploy should not fail over
 * a feature the school may not use — but a container disk is ephemeral, so
 * accepting a file there would quietly lose it.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  readonly driver: StorageDriver;
  readonly usable: boolean;
  readonly reason: string | null;

  constructor(config: ConfigService<AppConfig, true>) {
    const storage = config.get('storage', { infer: true });
    const app = config.get('app', { infer: true });

    if (
      storage.bucket &&
      storage.accountId &&
      storage.accessKeyId &&
      storage.secretAccessKey
    ) {
      this.driver = new R2StorageDriver(
        storage.bucket,
        storage.accountId,
        storage.accessKeyId,
        storage.secretAccessKey,
      );
      this.usable = true;
      this.reason = null;
      this.logger.log(`File storage: R2 bucket ${storage.bucket}`);
      return;
    }

    this.driver = new LocalStorageDriver(
      path.resolve(storage.localDir ?? 'storage'),
    );
    this.usable = !app.isProduction;
    this.reason = this.usable
      ? null
      : 'File uploads are not configured. Set the R2 credentials to enable them.';

    if (this.usable) {
      this.logger.warn(
        `File storage: local disk (${storage.localDir ?? 'storage'}) — fine for development, never for production`,
      );
    } else {
      this.logger.error(
        'File storage is unconfigured in production: uploads will be refused rather than written to an ephemeral disk',
      );
    }
  }
}
