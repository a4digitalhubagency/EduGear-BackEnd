import { MembershipStatus, SchoolStatus, UserStatus } from '@prisma/client';
import { RedisService } from '../cache/redis.service';
import { MembershipCacheService } from './membership-cache.service';
import type { MembershipSnapshot } from './access-control.service';

function snapshot(
  overrides: Partial<MembershipSnapshot> = {},
): MembershipSnapshot {
  return {
    membershipId: 'membership-1',
    userId: 'user-1',
    email: 'owner@example.com',
    firstName: 'Ada',
    lastName: 'Obi',
    schoolId: 'school-1',
    schoolSlug: 'bright-star',
    schoolName: 'Bright Star',
    schoolStatus: SchoolStatus.ACTIVE,
    roleId: 'role-1',
    roleSlug: 'proprietor',
    roleName: 'Proprietor',
    membershipStatus: MembershipStatus.ACTIVE,
    userStatus: UserStatus.ACTIVE,
    tokenVersion: 0,
    permissions: new Set(['users.read', 'users.create']),
    ...overrides,
  };
}

/** Stands in for RedisService with no connection — the single-instance path. */
function withoutRedis(): MembershipCacheService {
  return new MembershipCacheService({
    client: null,
    isEnabled: false,
    keyPrefix: 'edugear:',
    key: (...parts: string[]) => `edugear:${parts.join(':')}`,
  } as unknown as RedisService);
}

describe('MembershipCacheService (in-process fallback)', () => {
  it('returns a stored snapshot', async () => {
    const cache = withoutRedis();
    await cache.set(snapshot());

    const found = await cache.get('membership-1');
    expect(found?.permissions.has('users.read')).toBe(true);
  });

  it('misses for an unknown membership', async () => {
    const cache = withoutRedis();
    expect(await cache.get('nope')).toBeNull();
  });

  it('drops a snapshot once its TTL has passed', async () => {
    jest.useFakeTimers();
    try {
      const cache = withoutRedis();
      await cache.set(snapshot());

      jest.advanceTimersByTime(
        MembershipCacheService.TTL_SECONDS * 1000 + 1_000,
      );

      expect(await cache.get('membership-1')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('invalidates every membership holding a role', async () => {
    const cache = withoutRedis();
    await cache.set(snapshot({ membershipId: 'm1', roleId: 'role-x' }));
    await cache.set(snapshot({ membershipId: 'm2', roleId: 'role-x' }));
    await cache.set(snapshot({ membershipId: 'm3', roleId: 'role-y' }));

    await cache.invalidateRole('role-x');

    expect(await cache.get('m1')).toBeNull();
    expect(await cache.get('m2')).toBeNull();
    expect(await cache.get('m3')).not.toBeNull();
  });

  it('invalidates every membership belonging to a user', async () => {
    const cache = withoutRedis();
    await cache.set(snapshot({ membershipId: 'm1', userId: 'user-x' }));
    await cache.set(snapshot({ membershipId: 'm2', userId: 'user-y' }));

    await cache.invalidateUser('user-x');

    expect(await cache.get('m1')).toBeNull();
    expect(await cache.get('m2')).not.toBeNull();
  });
});

describe('MembershipCacheService (Redis)', () => {
  /** Minimal in-memory stand-in for the ioredis surface the cache uses. */
  function fakeRedis() {
    const strings = new Map<string, string>();
    const sets = new Map<string, Set<string>>();

    const client = {
      get: jest.fn((key: string) => Promise.resolve(strings.get(key) ?? null)),
      del: jest.fn((...keys: string[]) => {
        let removed = 0;
        for (const key of keys) {
          if (strings.delete(key)) removed++;
          sets.delete(key);
        }
        return Promise.resolve(removed);
      }),
      smembers: jest.fn((key: string) =>
        Promise.resolve([...(sets.get(key) ?? [])]),
      ),
      multi: jest.fn(() => {
        const chain: Record<string, unknown> = {
          set: (key: string, value: string) => {
            strings.set(key, value);
            return chain;
          },
          sadd: (key: string, member: string) => {
            const existing = sets.get(key) ?? new Set<string>();
            existing.add(member);
            sets.set(key, existing);
            return chain;
          },
          expire: () => chain,
          exec: () => Promise.resolve([]),
        };
        return chain;
      }),
    };

    return { client, strings, sets };
  }

  function withRedis(client: unknown): MembershipCacheService {
    return new MembershipCacheService({
      client,
      isEnabled: true,
      keyPrefix: 'edugear:',
      key: (...parts: string[]) => `edugear:${parts.join(':')}`,
    } as unknown as RedisService);
  }

  it('round-trips a snapshot through serialization, preserving permissions', async () => {
    const { client } = fakeRedis();
    const cache = withRedis(client);

    await cache.set(snapshot());
    const found = await cache.get('membership-1');

    expect(found).not.toBeNull();
    // The Set survives the JSON round trip — the thing plain JSON gets wrong.
    expect(found?.permissions).toBeInstanceOf(Set);
    expect([...(found?.permissions ?? [])].sort()).toEqual([
      'users.create',
      'users.read',
    ]);
    expect(found?.schoolStatus).toBe(SchoolStatus.ACTIVE);
  });

  it('invalidates across instances via the role index', async () => {
    const { client } = fakeRedis();
    const cache = withRedis(client);

    await cache.set(snapshot({ membershipId: 'm1', roleId: 'role-x' }));
    await cache.set(snapshot({ membershipId: 'm2', roleId: 'role-x' }));

    await cache.invalidateRole('role-x');

    expect(await cache.get('m1')).toBeNull();
    expect(await cache.get('m2')).toBeNull();
  });

  it('treats a Redis outage as a cache miss rather than an error', async () => {
    const { client } = fakeRedis();
    client.get = jest.fn(() =>
      Promise.reject(new Error('connection refused')),
    ) as unknown as typeof client.get;
    const cache = withRedis(client);

    await expect(cache.get('membership-1')).resolves.toBeNull();
  });

  it('ignores a snapshot written in an older, incompatible shape', async () => {
    const { client, strings } = fakeRedis();
    strings.set('edugear:acl:m:membership-1', JSON.stringify({ stale: true }));

    await expect(withRedis(client).get('membership-1')).resolves.toBeNull();
  });
});
