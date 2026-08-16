import { Prisma } from '@prisma/client';
import { RequestContext } from '../common/context/request-context';
import { GLOBAL_MODELS, TENANT_SCOPED_MODELS } from './tenant-models';

/**
 * Guards the guard. If someone adds a model with a `schoolId` column and forgets
 * to register it, this fails — which is the whole point: tenant scoping must not
 * depend on anyone remembering.
 */
describe('Tenant model registry', () => {
  const models = Prisma.dmmf.datamodel.models;

  it('registers every model that carries a schoolId column', () => {
    const withTenantColumn = models
      .filter((model) =>
        model.fields.some((field) => field.name === 'schoolId'),
      )
      .map((model) => model.name);

    const unregistered = withTenantColumn.filter(
      (name) => !(name in TENANT_SCOPED_MODELS),
    );

    expect(unregistered).toEqual([]);
  });

  it('accounts for every model in the schema exactly once', () => {
    const known = new Set([
      ...Object.keys(TENANT_SCOPED_MODELS),
      ...GLOBAL_MODELS,
    ]);
    const unaccounted = models
      .map((m) => m.name)
      .filter((name) => !known.has(name));

    expect(unaccounted).toEqual([]);
  });

  it('points each registered model at a column that exists', () => {
    for (const [modelName, config] of Object.entries(TENANT_SCOPED_MODELS)) {
      const model = models.find((m) => m.name === modelName);
      expect(model).toBeDefined();
      expect(model!.fields.some((field) => field.name === config.field)).toBe(
        true,
      );
    }
  });

  it('marks a model nullable only when the column really is optional', () => {
    for (const [modelName, config] of Object.entries(TENANT_SCOPED_MODELS)) {
      const field = models
        .find((m) => m.name === modelName)!
        .fields.find((f) => f.name === config.field)!;

      expect(field.isRequired).toBe(!config.nullable);
    }
  });
});

describe('RequestContext', () => {
  it('has no tenant outside a request', () => {
    expect(RequestContext.getTenantId()).toBeNull();
    expect(RequestContext.isSystemScope()).toBe(false);
  });

  it('exposes the tenant inside runWithTenant', () => {
    RequestContext.runWithTenant(
      {
        userId: 'user-1',
        membershipId: 'membership-1',
        schoolId: 'school-1',
        roleId: 'role-1',
        roleSlug: 'PROPRIETOR',
        email: 'owner@example.com',
      },
      () => {
        expect(RequestContext.getTenantId()).toBe('school-1');
        expect(RequestContext.isSystemScope()).toBe(false);
      },
    );
  });

  it('keeps the tenant context across awaits', async () => {
    await RequestContext.runWithTenant(
      {
        userId: 'user-1',
        membershipId: 'membership-1',
        schoolId: 'school-42',
        roleId: 'role-1',
        roleSlug: 'PROPRIETOR',
        email: 'owner@example.com',
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(RequestContext.getTenantId()).toBe('school-42');
      },
    );
  });

  it('lifts scoping only for the duration of runAsSystem', () => {
    RequestContext.run({ requestId: 'req-1' }, () => {
      expect(RequestContext.isSystemScope()).toBe(false);
      RequestContext.runAsSystem(() => {
        expect(RequestContext.isSystemScope()).toBe(true);
      });
      expect(RequestContext.isSystemScope()).toBe(false);
    });
  });

  it('keeps the request id when entering system scope', () => {
    RequestContext.run({ requestId: 'req-9' }, () => {
      RequestContext.runAsSystem(() => {
        expect(RequestContext.getRequestId()).toBe('req-9');
      });
    });
  });

  it('sets auth on the live store so later code sees the tenant', () => {
    RequestContext.run({ requestId: 'req-2' }, () => {
      expect(RequestContext.getTenantId()).toBeNull();
      RequestContext.setAuth({
        userId: 'user-2',
        membershipId: 'membership-2',
        schoolId: 'school-2',
        roleId: 'role-2',
        roleSlug: 'TEACHER',
        email: 'teacher@example.com',
      });
      expect(RequestContext.getTenantId()).toBe('school-2');
    });
  });
});
