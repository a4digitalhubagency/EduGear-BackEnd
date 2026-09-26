import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Identity resolved from a verified access token. The server builds this from the
 * token's membership id — a client-supplied tenant id is never trusted.
 */
export interface AuthContext {
  userId: string;
  membershipId: string;
  schoolId: string;
  roleId: string;
  roleSlug: string;
  email: string;
}

/**
 * A platform operator, resolved from a verified platform token. There is no
 * school here and there never is: platform routes read across tenants through
 * `runAsSystem`, and every one of them is explicit about it.
 */
export interface PlatformContext {
  userId: string;
  platformAdminId: string;
  role: string;
  email: string;
}

export interface RequestContextStore {
  requestId: string;
  /**
   * Set when a task acts for one school with no user behind it — a provider
   * webhook, a scheduled job. The tenant guard scopes to it exactly as it
   * would to a signed-in member of staff.
   */
  systemTenantId?: string;
  ip?: string;
  userAgent?: string;
  /** Null until the auth guard has verified a token. Mutated in place. */
  auth: AuthContext | null;
  /**
   * Set instead of `auth` when the caller is A4's own staff rather than a
   * school's. Never both: a token is one kind or the other.
   */
  platform: PlatformContext | null;
  /**
   * When true the tenant guard stops injecting `schoolId`. Only ever set by
   * `runAsSystem`, which exists for login (user lookup by email), tenant
   * provisioning, seeds and background jobs.
   */
  systemScope: boolean;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/**
 * Prisma promises are lazy: nothing runs until something calls `.then()`. If a
 * callback merely *returns* a query, the query would execute in whatever context
 * awaited it — outside the scope we just opened. Subscribing here forces
 * execution to begin inside the active store.
 */
function startInContext<T>(result: T): T {
  const isThenable =
    result !== null &&
    (typeof result === 'object' || typeof result === 'function') &&
    typeof (result as { then?: unknown }).then === 'function';

  return isThenable ? (Promise.resolve(result) as T) : result;
}

export class TenantContextMissingError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Refusing to run ${model}.${operation} without tenant context. ` +
        `Tenant-scoped queries must run inside a request, RequestContext.runWithTenant(), ` +
        `or an explicit RequestContext.runAsSystem() block.`,
    );
    this.name = 'TenantContextMissingError';
  }
}

export const RequestContext = {
  /** Wraps a request (or job) so everything downstream shares one context. */
  run<T>(seed: Partial<RequestContextStore>, fn: () => T): T {
    const store: RequestContextStore = {
      requestId: seed.requestId ?? randomUUID(),
      ip: seed.ip,
      userAgent: seed.userAgent,
      auth: seed.auth ?? null,
      platform: seed.platform ?? null,
      systemTenantId: seed.systemTenantId,
      systemScope: seed.systemScope ?? false,
    };
    return storage.run(store, () => startInContext(fn()));
  },

  /** Runs `fn` scoped to a tenant. For jobs, seeds and tests — not request handling. */
  runWithTenant<T>(auth: AuthContext, fn: () => T): T {
    return RequestContext.run({ auth }, fn);
  },

  /**
   * Escape hatch: disables tenant filtering for the duration of `fn`.
   * Deliberately verbose so `grep runAsSystem` lists every unscoped code path.
   */
  runAsSystem<T>(fn: () => T): T {
    const current = storage.getStore();
    if (current) {
      // Preserve request id / actor for audit logging while lifting the filter.
      return storage.run({ ...current, systemScope: true }, () =>
        startInContext(fn()),
      );
    }
    return RequestContext.run({ systemScope: true }, fn);
  },

  get(): RequestContextStore | undefined {
    return storage.getStore();
  },

  getRequestId(): string | undefined {
    return storage.getStore()?.requestId;
  },

  getAuth(): AuthContext | null {
    return storage.getStore()?.auth ?? null;
  },

  /** The active tenant, or null when unauthenticated / in system scope. */
  getTenantId(): string | null {
    const store = storage.getStore();
    return store?.auth?.schoolId ?? store?.systemTenantId ?? null;
  },

  /**
   * Runs `fn` scoped to one school with no user attached — for work a person
   * did not ask for directly, such as a payment provider's webhook. Everything
   * downstream is tenant-scoped as usual; audit entries simply have no actor.
   */
  runForSchool<T>(schoolId: string, fn: () => T): T {
    return RequestContext.run({ systemTenantId: schoolId }, fn);
  },

  isSystemScope(): boolean {
    return storage.getStore()?.systemScope ?? false;
  },

  /** Called by the JWT strategy once a token has been verified. */
  setAuth(auth: AuthContext): void {
    const store = storage.getStore();
    if (store) {
      store.auth = auth;
    }
  },

  /**
   * The platform counterpart of `setAuth`. Deliberately does not touch `auth`,
   * so no platform request ever carries a tenant the guard could pick up.
   */
  setPlatform(platform: PlatformContext): void {
    const store = storage.getStore();
    if (store) {
      store.platform = platform;
    }
  },

  getPlatform(): PlatformContext | null {
    return storage.getStore()?.platform ?? null;
  },
};
