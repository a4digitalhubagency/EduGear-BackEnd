import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { StorageDriver } from './storage.driver';

/**
 * Files on disk, for development and tests.
 *
 * Keys are built by the server and never contain a caller's input, but the
 * path is still resolved and checked against the root before anything is
 * written or read — a traversal bug elsewhere should not become a write to
 * /etc. Production uses R2; disks on the platforms we deploy to are ephemeral.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local';

  constructor(private readonly root: string) {}

  // The content type is recorded in the database, not on the file.
  async put(key: string, body: Buffer): Promise<void> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  }

  get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  private resolve(key: string): string {
    const target = path.resolve(this.root, key);
    const root = path.resolve(this.root);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`Refusing to touch ${key}: outside the storage root`);
    }
    return target;
  }
}
