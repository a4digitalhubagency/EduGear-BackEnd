import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../cache/redis.service';
import type { MembershipSnapshot } from './access-control.service';

/**
 * Stores "what may this membership do" between requests.
 *
 * Backed by Redis when it is configured, so an invalidation on one instance is
 * seen by every other. Without Redis it degrades to the original in-process Map,
 * which is correct for exactly one instance — production refuses to boot without
 * `REDIS_URL`, so the degraded path is a development convenience only.
 *
 * `invalidateRole` / `invalidateUser` need to find every membership affected by a
 * change. A Map can be scanned; Redis cannot, so writes also maintain reverse
 * index sets (role -> memberships, user -> memberships).
 *
 * Redis failures never break a request: reads fall through to the database and
 * writes are logged. A failed *invalidation* is logged as an error because it
 * leaves stale permissions readable until the TTL expires.
 */

/** JSON-safe form of a snapshot: `Set` and `Map` do not survive serialization. */
interface SerializedSnapshot extends Omit<MembershipSnapshot, 'permissions'> {
  permissions: string[];
}

@Injectable()
export class MembershipCacheService {
  static readonly TTL_SECONDS = 30;
  /** Index sets outlive snapshots so an invalidation can still find live entries. */
  private static readonly INDEX_TTL_SECONDS = 300;

  private readonly logger = new Logger(MembershipCacheService.name);
  private readonly local = new Map<
    string,
    { expiresAt: number; snapshot: MembershipSnapshot }
  >();

  constructor(private readonly redis: RedisService) {}

  async get(membershipId: string): Promise<MembershipSnapshot | null> {
    const client = this.redis.client;
    if (!client) return this.getLocal(membershipId);

    try {
      const raw = await client.get(this.membershipKey(membershipId));
      if (!raw) return null;
      return this.deserialize(raw);
    } catch (error) {
      // A cache miss is always safe — the caller re-reads from the database.
      this.logger.warn(
        `Redis read failed for membership ${membershipId}: ${this.message(error)}`,
      );
      return null;
    }
  }

  async set(snapshot: MembershipSnapshot): Promise<void> {
    const client = this.redis.client;
    if (!client) {
      this.setLocal(snapshot);
      return;
    }

    try {
      await client
        .multi()
        .set(
          this.membershipKey(snapshot.membershipId),
          JSON.stringify(this.serialize(snapshot)),
          'EX',
          MembershipCacheService.TTL_SECONDS,
        )
        .sadd(this.roleKey(snapshot.roleId), snapshot.membershipId)
        .expire(
          this.roleKey(snapshot.roleId),
          MembershipCacheService.INDEX_TTL_SECONDS,
        )
        .sadd(this.userKey(snapshot.userId), snapshot.membershipId)
        .expire(
          this.userKey(snapshot.userId),
          MembershipCacheService.INDEX_TTL_SECONDS,
        )
        .exec();
    } catch (error) {
      this.logger.warn(`Redis write failed: ${this.message(error)}`);
    }
  }

  async invalidateMembership(membershipId: string): Promise<void> {
    const client = this.redis.client;
    if (!client) {
      this.local.delete(membershipId);
      return;
    }

    try {
      await client.del(this.membershipKey(membershipId));
    } catch (error) {
      this.logger.error(
        `Failed to invalidate membership ${membershipId}; stale permissions may ` +
          `be served for up to ${MembershipCacheService.TTL_SECONDS}s: ${this.message(error)}`,
      );
    }
  }

  /** Every member holding this role is affected when its permissions change. */
  async invalidateRole(roleId: string): Promise<void> {
    await this.invalidateIndexed(
      this.roleKey(roleId),
      (entry) => entry.snapshot.roleId === roleId,
      `role ${roleId}`,
    );
  }

  /** For password change / logout-all, which bump the user's token version. */
  async invalidateUser(userId: string): Promise<void> {
    await this.invalidateIndexed(
      this.userKey(userId),
      (entry) => entry.snapshot.userId === userId,
      `user ${userId}`,
    );
  }

  async clear(): Promise<void> {
    this.local.clear();
    const client = this.redis.client;
    if (!client) return;

    try {
      // Scoped to our namespace: a shared Redis must not be flushed wholesale.
      const pattern = this.redis.key('acl', '*');
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100,
        );
        cursor = next;
        if (keys.length > 0) await client.del(...keys);
      } while (cursor !== '0');
    } catch (error) {
      this.logger.warn(`Redis clear failed: ${this.message(error)}`);
    }
  }

  private async invalidateIndexed(
    indexKey: string,
    matchesLocal: (entry: { snapshot: MembershipSnapshot }) => boolean,
    label: string,
  ): Promise<void> {
    const client = this.redis.client;
    if (!client) {
      for (const [key, entry] of this.local.entries()) {
        if (matchesLocal(entry)) this.local.delete(key);
      }
      return;
    }

    try {
      const membershipIds = await client.smembers(indexKey);
      const keys = membershipIds.map((id) => this.membershipKey(id));
      // Drop the index alongside the snapshots; `set` rebuilds it on next read.
      await client.del(...keys, indexKey);
    } catch (error) {
      this.logger.error(
        `Failed to invalidate ${label}; stale permissions may be served for up to ` +
          `${MembershipCacheService.TTL_SECONDS}s: ${this.message(error)}`,
      );
    }
  }

  private getLocal(membershipId: string): MembershipSnapshot | null {
    const cached = this.local.get(membershipId);
    if (cached && cached.expiresAt > Date.now()) return cached.snapshot;
    if (cached) this.local.delete(membershipId);
    return null;
  }

  private setLocal(snapshot: MembershipSnapshot): void {
    this.local.set(snapshot.membershipId, {
      expiresAt: Date.now() + MembershipCacheService.TTL_SECONDS * 1000,
      snapshot,
    });
  }

  private serialize(snapshot: MembershipSnapshot): SerializedSnapshot {
    return { ...snapshot, permissions: [...snapshot.permissions] };
  }

  private deserialize(raw: string): MembershipSnapshot | null {
    try {
      const parsed = JSON.parse(raw) as SerializedSnapshot;
      // A snapshot written by an older deploy may not match the current shape.
      if (!parsed?.membershipId || !Array.isArray(parsed.permissions)) {
        return null;
      }
      return {
        ...parsed,
        schoolStatus: parsed.schoolStatus,
        membershipStatus: parsed.membershipStatus,
        userStatus: parsed.userStatus,
        permissions: new Set(parsed.permissions),
      };
    } catch {
      return null;
    }
  }

  private membershipKey(membershipId: string): string {
    return this.redis.key('acl', 'm', membershipId);
  }

  private roleKey(roleId: string): string {
    return this.redis.key('acl', 'role', roleId);
  }

  private userKey(userId: string): string {
    return this.redis.key('acl', 'user', userId);
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
