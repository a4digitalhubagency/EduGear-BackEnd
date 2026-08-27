/**
 * Integration tests use a dedicated Redis logical database.
 *
 * Rate-limit counters outlive a test run (the auth budget has a 60s TTL, the
 * strict one an hour), so the suite has to start from a clean keyspace or a
 * second run inside the hour fails on counters left by the first. Flushing is
 * therefore required — and flushing db 0 would wipe whatever a developer's local
 * app has cached, so tests are moved off it.
 */
export const TEST_REDIS_DB = 1;

export function testRedisUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const url = new URL(raw);
  url.pathname = `/${TEST_REDIS_DB}`;
  return url.toString();
}
