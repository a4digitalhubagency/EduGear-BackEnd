import { ALL_PERMISSIONS, PERMISSIONS, PermissionKey } from './permissions';

export const SYSTEM_ROLES = {
  PROPRIETOR: 'PROPRIETOR',
  PRINCIPAL: 'PRINCIPAL',
  ADMINISTRATOR: 'ADMINISTRATOR',
  ACCOUNTANT: 'ACCOUNTANT',
  TEACHER: 'TEACHER',
  PARENT: 'PARENT',
} as const;

export type SystemRoleSlug = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

export interface SystemRoleDefinition {
  slug: SystemRoleSlug;
  name: string;
  description: string;
  permissions: PermissionKey[];
}

const P = PERMISSIONS;

/**
 * Templates copied into every new school. A school may later edit its own copy
 * (Phase 5) without affecting other tenants.
 */
export const SYSTEM_ROLE_DEFINITIONS: SystemRoleDefinition[] = [
  {
    slug: SYSTEM_ROLES.PROPRIETOR,
    name: 'Proprietor',
    description: 'School owner. Full access to every module.',
    // Owner keeps everything except the parent-portal permission, which is
    // guardian-scoped and meaningless for staff.
    permissions: ALL_PERMISSIONS.filter((p) => p !== P.PORTAL_ACCESS),
  },
  {
    slug: SYSTEM_ROLES.PRINCIPAL,
    name: 'Principal',
    description: 'Head of school. Academic and administrative oversight.',
    permissions: [
      P.STUDENTS_READ,
      P.STUDENTS_CREATE,
      P.STUDENTS_UPDATE,
      P.STUDENTS_DELETE,
      P.GUARDIANS_READ,
      P.GUARDIANS_CREATE,
      P.GUARDIANS_UPDATE,
      P.ACADEMICS_READ,
      P.ACADEMICS_CREATE,
      P.ACADEMICS_UPDATE,
      P.ACADEMICS_DELETE,
      P.ATTENDANCE_READ,
      P.ATTENDANCE_CREATE,
      P.ATTENDANCE_UPDATE,
      P.RESULTS_READ,
      P.RESULTS_CREATE,
      P.RESULTS_UPDATE,
      P.RESULTS_PUBLISH,
      P.FINANCE_READ,
      P.USERS_READ,
      P.USERS_CREATE,
      P.USERS_UPDATE,
      P.USERS_DELETE,
      P.ROLES_READ,
      P.SCHOOL_READ,
      P.SCHOOL_UPDATE,
      P.REPORTS_READ,
      P.REPORTS_EXPORT,
      P.AUDIT_READ,
    ],
  },
  {
    slug: SYSTEM_ROLES.ADMINISTRATOR,
    name: 'Administrator',
    description: 'School administrator. Day-to-day records and staff accounts.',
    permissions: [
      P.STUDENTS_READ,
      P.STUDENTS_CREATE,
      P.STUDENTS_UPDATE,
      P.GUARDIANS_READ,
      P.GUARDIANS_CREATE,
      P.GUARDIANS_UPDATE,
      P.ACADEMICS_READ,
      P.ACADEMICS_CREATE,
      P.ACADEMICS_UPDATE,
      P.ATTENDANCE_READ,
      P.ATTENDANCE_CREATE,
      P.ATTENDANCE_UPDATE,
      P.RESULTS_READ,
      P.FINANCE_READ,
      P.USERS_READ,
      P.USERS_CREATE,
      P.USERS_UPDATE,
      P.SCHOOL_READ,
      P.REPORTS_READ,
      P.REPORTS_EXPORT,
    ],
  },
  {
    slug: SYSTEM_ROLES.ACCOUNTANT,
    name: 'Accountant',
    description: 'Bursar. Fees, payments and payment verification.',
    permissions: [
      P.FINANCE_READ,
      P.FINANCE_CREATE,
      P.FINANCE_UPDATE,
      P.FINANCE_VERIFY,
      P.STUDENTS_READ,
      P.GUARDIANS_READ,
      P.ACADEMICS_READ,
      P.SCHOOL_READ,
      P.REPORTS_READ,
      P.REPORTS_EXPORT,
    ],
  },
  {
    slug: SYSTEM_ROLES.TEACHER,
    name: 'Teacher',
    description: 'Teaching staff. Attendance and score entry, no publishing.',
    permissions: [
      P.STUDENTS_READ,
      P.GUARDIANS_READ,
      P.ACADEMICS_READ,
      P.ATTENDANCE_READ,
      P.ATTENDANCE_CREATE,
      P.ATTENDANCE_UPDATE,
      P.RESULTS_READ,
      P.RESULTS_CREATE,
      P.RESULTS_UPDATE,
      P.SCHOOL_READ,
    ],
  },
  {
    slug: SYSTEM_ROLES.PARENT,
    name: 'Parent',
    description: 'Guardian portal access, limited to their own children.',
    // No school-wide permissions: portal endpoints additionally filter by the
    // guardian's linked students.
    permissions: [P.PORTAL_ACCESS],
  },
];

export const SYSTEM_ROLE_SLUGS = SYSTEM_ROLE_DEFINITIONS.map((r) => r.slug);
