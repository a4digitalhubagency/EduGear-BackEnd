import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

/**
 * Who a rate-limit budget belongs to.
 *
 * Every request from the web app arrives from the same place: the Next server
 * renders and calls this API itself, so Express sees one socket address for the
 * entire school estate. Keyed on that, the whole platform shares one budget and
 * the first busy morning spends it — 120 requests a minute is a single teacher
 * scrolling, and ten logins a minute is two classrooms arriving at once.
 *
 * `X-Forwarded-For` cannot be the answer. The API is reachable directly, so any
 * client can send that header, and taking a hop further back from it would let
 * anyone mint a fresh budget per request and opt out of rate limiting entirely.
 *
 * So the front end proves it is the front end. It sends the real client address
 * alongside a secret only it and this service know, and only then is the
 * address believed. No secret, a wrong secret, or an address that is not an
 * address, and the socket IP is used instead — the budget narrows to one shared
 * bucket, which is the pre-existing behaviour and never an open door.
 */

/** The caller's claim about who it is speaking for. */
export const CLIENT_IP_HEADER = 'x-client-ip';

/** Proof that the claim comes from our own front end. */
export const EDGE_SECRET_HEADER = 'x-edge-secret';

export interface TrackerInput {
  /** Value of `x-client-ip`, if the caller sent one. */
  clientIp: unknown;
  /** Value of `x-edge-secret`, if the caller sent one. */
  edgeSecret: unknown;
  /** What the socket says, after Express applies `trust proxy`. */
  socketIp: string | undefined;
  /** The configured secret. Unset disables the header entirely. */
  configuredSecret: string | undefined;
}

/**
 * Keys are namespaced by how much they are trusted. A forwarded address and a
 * socket address can be the same string, and without the prefix an attacker
 * reaching the API directly from some address could spend the budget of a
 * real user who happens to sit behind it.
 */
export function resolveTracker(input: TrackerInput): string {
  const forwarded = trustedClientIp(input);
  if (forwarded) return `fwd:${forwarded}`;
  return `ip:${normaliseIp(input.socketIp) ?? 'unknown'}`;
}

function trustedClientIp(input: TrackerInput): string | null {
  const { configuredSecret } = input;
  if (!configuredSecret) return null;

  if (!secretMatches(input.edgeSecret, configuredSecret)) return null;

  // One address, never a list: an `X-Forwarded-For`-style chain pasted in here
  // would make the key depend on hops this service has no way to verify.
  return normaliseIp(input.clientIp);
}

function secretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length, so compare lengths without branching on the contents.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Returns a canonical address, or null if the value is not one.
 *
 * Canonical matters: `::ffff:102.89.68.254` and `102.89.68.254` are the same
 * client, and two keys for one client is two budgets.
 */
export function normaliseIp(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  let candidate = value.trim().toLowerCase();
  if (candidate.length === 0 || candidate.length > 45) return null;

  // Strip an IPv6 zone index (`fe80::1%eth0`): same address, different text.
  const zone = candidate.indexOf('%');
  if (zone !== -1) candidate = candidate.slice(0, zone);

  // IPv4-mapped IPv6, which is how Node reports an IPv4 client on a dual stack.
  if (candidate.startsWith('::ffff:')) {
    const mapped = candidate.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return mapped;
  }

  return isIP(candidate) === 0 ? null : candidate;
}
