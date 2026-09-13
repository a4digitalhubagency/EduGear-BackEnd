/**
 * Registry of tenant-owned Prisma models.
 *
 * Adding a model with a `schoolId` column and forgetting to register it here is
 * caught by `tenant-guard.extension.spec.ts`, which walks the Prisma DMMF and
 * fails if any model carrying `schoolId` is missing from this map.
 */
export interface TenantModelConfig {
  /** Column holding the tenant id. `School` is the tenant, so it scopes on `id`. */
  field: string;
  /**
   * True when the column is nullable (AuditLog records pre-tenant security
   * events). Reads stay scoped; only system-scope writes may leave it null.
   */
  nullable?: boolean;
}

export const TENANT_SCOPED_MODELS: Readonly<Record<string, TenantModelConfig>> =
  {
    School: { field: 'id' },
    Role: { field: 'schoolId' },
    Membership: { field: 'schoolId' },
    AcademicSession: { field: 'schoolId' },
    Term: { field: 'schoolId' },
    Class: { field: 'schoolId' },
    ClassArm: { field: 'schoolId' },
    Student: { field: 'schoolId' },
    Guardian: { field: 'schoolId' },
    StudentGuardian: { field: 'schoolId' },
    FeeCategory: { field: 'schoolId' },
    FeeStructure: { field: 'schoolId' },
    FeeStructureItem: { field: 'schoolId' },
    StudentFee: { field: 'schoolId' },
    StudentFeeItem: { field: 'schoolId' },
    Payment: { field: 'schoolId' },
    FeeReminder: { field: 'schoolId' },
    AuditLog: { field: 'schoolId', nullable: true },
  };

/**
 * Models that intentionally hold no tenant column.
 * `User`, `RefreshToken` and `VerificationToken` are global identity records —
 * a user can hold memberships in several schools. `Permission` and
 * `RolePermission` are catalogue data (RolePermission is reachable only through
 * a tenant-scoped Role).
 */
export const GLOBAL_MODELS: readonly string[] = [
  'User',
  'Permission',
  'RolePermission',
  'RefreshToken',
  'VerificationToken',
];

export function isTenantScoped(
  model: string | undefined,
): model is keyof typeof TENANT_SCOPED_MODELS {
  return !!model && model in TENANT_SCOPED_MODELS;
}
