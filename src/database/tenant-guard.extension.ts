import { Prisma } from '@prisma/client';
import {
  RequestContext,
  TenantContextMissingError,
} from '../common/context/request-context';
import { TENANT_SCOPED_MODELS, TenantModelConfig } from './tenant-models';

/**
 * Cross-tenant data leakage prevention.
 *
 * Rather than trusting every developer to remember `where: { schoolId }`, this
 * Prisma client extension intercepts every operation on a tenant-owned model and:
 *
 *   1. injects the active tenant into `where` (reads, updates, deletes),
 *   2. forces the active tenant into `data` (creates),
 *   3. rejects attempts to move a row to another tenant via `data.schoolId`,
 *   4. THROWS when no tenant context exists — the default is failure, not leakage.
 *
 * The only way to run unscoped is `RequestContext.runAsSystem()`, which is
 * deliberately easy to grep for during review.
 *
 * Known limits (documented rather than silently assumed):
 *   - `$queryRaw` / `$executeRaw` bypass the guard; raw SQL must scope by hand.
 *   - Nested writes on relations inherit the parent row's tenant via FK, but the
 *     guard does not rewrite deeply nested `where` clauses; prefer top-level ops.
 *   - Postgres RLS can be layered underneath this later for defence in depth.
 */

/** Ops whose `where` accepts arbitrary filters. */
const WHERE_FILTER_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'updateMany',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

/**
 * Ops whose `where` must keep a unique field at the top level, so the tenant
 * column is merged in flat (Prisma's extended-where-unique allows the extra filter).
 */
const WHERE_UNIQUE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'delete',
  'upsert',
]);

const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);

function withTenantFilter(
  where: Record<string, unknown> | undefined,
  field: string,
  tenantId: string,
): Record<string, unknown> {
  // AND-wrapping keeps any caller-supplied filter intact: a caller asking for
  // another tenant's row gets an empty result instead of silently reading it.
  return where
    ? { AND: [where, { [field]: tenantId }] }
    : { [field]: tenantId };
}

/** Renders an untrusted value for an error message without `[object Object]`. */
function describe(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function assertNoTenantOverride(
  data: unknown,
  field: string,
  tenantId: string,
  model: string,
): void {
  if (!data || typeof data !== 'object') return;
  const value = (data as Record<string, unknown>)[field];
  if (value !== undefined && value !== tenantId) {
    throw new Error(
      `Refusing to write ${model}.${field}=${describe(value)} while the active tenant is ${tenantId}.`,
    );
  }
}

function applyTenantToCreateData(
  data: unknown,
  field: string,
  tenantId: string,
  model: string,
): unknown {
  if (Array.isArray(data)) {
    return data.map((row) =>
      applyTenantToCreateData(row, field, tenantId, model),
    );
  }
  if (!data || typeof data !== 'object') return data;
  assertNoTenantOverride(data, field, tenantId, model);
  return { ...(data as Record<string, unknown>), [field]: tenantId };
}

export function tenantGuardExtension() {
  return Prisma.defineExtension({
    name: 'edugear-tenant-guard',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          const config: TenantModelConfig | undefined =
            model &&
            TENANT_SCOPED_MODELS[model as keyof typeof TENANT_SCOPED_MODELS];

          // Untenanted model (User, Permission, ...) — nothing to enforce.
          if (!config) {
            return await query(args);
          }

          if (RequestContext.isSystemScope()) {
            return await query(args);
          }

          const tenantId = RequestContext.getTenantId();
          if (!tenantId) {
            throw new TenantContextMissingError(
              String(model),
              String(operation),
            );
          }

          const { field } = config;
          const nextArgs = { ...(args ?? {}) } as Record<string, any>;

          if (WHERE_FILTER_OPS.has(operation)) {
            nextArgs.where = withTenantFilter(nextArgs.where, field, tenantId);
          } else if (WHERE_UNIQUE_OPS.has(operation)) {
            // Flat merge: `findUnique` still needs its unique field at the top level.
            nextArgs.where = { ...(nextArgs.where ?? {}), [field]: tenantId };
          }

          if (CREATE_OPS.has(operation) && nextArgs.data !== undefined) {
            nextArgs.data = applyTenantToCreateData(
              nextArgs.data,
              field,
              tenantId,
              String(model),
            );
          }

          if (operation === 'upsert') {
            if (nextArgs.create !== undefined) {
              nextArgs.create = applyTenantToCreateData(
                nextArgs.create,
                field,
                tenantId,
                String(model),
              );
            }
            assertNoTenantOverride(
              nextArgs.update,
              field,
              tenantId,
              String(model),
            );
          }

          if (
            (operation === 'update' || operation === 'updateMany') &&
            nextArgs.data
          ) {
            // Block tenant reassignment through an update.
            assertNoTenantOverride(
              nextArgs.data,
              field,
              tenantId,
              String(model),
            );
          }

          return await query(nextArgs);
        },
      },
    },
  });
}
