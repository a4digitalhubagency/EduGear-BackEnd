/**
 * Permission catalogue. Authorization is permission-based everywhere — guards
 * check permissions, never `if (role === 'PRINCIPAL')`. Roles are just bundles,
 * which is what lets a school retune a role later without a code change.
 */
export const PERMISSIONS = {
  // Students
  STUDENTS_READ: 'students.read',
  STUDENTS_CREATE: 'students.create',
  STUDENTS_UPDATE: 'students.update',
  STUDENTS_DELETE: 'students.delete',

  // Guardians
  GUARDIANS_READ: 'guardians.read',
  GUARDIANS_CREATE: 'guardians.create',
  GUARDIANS_UPDATE: 'guardians.update',
  GUARDIANS_DELETE: 'guardians.delete',

  // Academic structure: sessions, terms, classes, arms
  ACADEMICS_READ: 'academics.read',
  ACADEMICS_CREATE: 'academics.create',
  ACADEMICS_UPDATE: 'academics.update',
  ACADEMICS_DELETE: 'academics.delete',

  // Attendance
  ATTENDANCE_READ: 'attendance.read',
  ATTENDANCE_CREATE: 'attendance.create',
  ATTENDANCE_UPDATE: 'attendance.update',

  // Finance
  FINANCE_READ: 'finance.read',
  FINANCE_CREATE: 'finance.create',
  FINANCE_UPDATE: 'finance.update',
  FINANCE_VERIFY: 'finance.verify',

  // Results
  RESULTS_READ: 'results.read',
  RESULTS_CREATE: 'results.create',
  RESULTS_UPDATE: 'results.update',
  RESULTS_PUBLISH: 'results.publish',

  // Staff / user administration
  USERS_READ: 'users.read',
  USERS_CREATE: 'users.create',
  USERS_UPDATE: 'users.update',
  USERS_DELETE: 'users.delete',

  // Roles and permissions
  ROLES_READ: 'roles.read',
  ROLES_UPDATE: 'roles.update',

  // School settings
  SCHOOL_READ: 'school.read',
  SCHOOL_UPDATE: 'school.update',

  // Reporting
  REPORTS_READ: 'reports.read',
  REPORTS_EXPORT: 'reports.export',

  // Audit trail
  AUDIT_READ: 'audit.read',

  // Parent portal access (guardian-scoped, not school-wide)
  PORTAL_ACCESS: 'portal.access',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {
  [PERMISSIONS.STUDENTS_READ]: 'View student records',
  [PERMISSIONS.STUDENTS_CREATE]: 'Admit and create student records',
  [PERMISSIONS.STUDENTS_UPDATE]: 'Update student records',
  [PERMISSIONS.STUDENTS_DELETE]: 'Deactivate or remove student records',
  [PERMISSIONS.GUARDIANS_READ]: 'View guardian records',
  [PERMISSIONS.GUARDIANS_CREATE]: 'Create guardian records',
  [PERMISSIONS.GUARDIANS_UPDATE]: 'Update guardian records',
  [PERMISSIONS.GUARDIANS_DELETE]: 'Remove guardian records',
  [PERMISSIONS.ACADEMICS_READ]: 'View sessions, terms, classes and arms',
  [PERMISSIONS.ACADEMICS_CREATE]: 'Create sessions, terms, classes and arms',
  [PERMISSIONS.ACADEMICS_UPDATE]: 'Update academic configuration',
  [PERMISSIONS.ACADEMICS_DELETE]: 'Delete academic configuration',
  [PERMISSIONS.ATTENDANCE_READ]: 'View attendance records',
  [PERMISSIONS.ATTENDANCE_CREATE]: 'Record attendance',
  [PERMISSIONS.ATTENDANCE_UPDATE]: 'Amend attendance records',
  [PERMISSIONS.FINANCE_READ]: 'View fees, invoices and payments',
  [PERMISSIONS.FINANCE_CREATE]: 'Create fee structures and record payments',
  [PERMISSIONS.FINANCE_UPDATE]: 'Update finance records',
  [PERMISSIONS.FINANCE_VERIFY]: 'Verify or reject payment evidence',
  [PERMISSIONS.RESULTS_READ]: 'View results and report cards',
  [PERMISSIONS.RESULTS_CREATE]: 'Enter scores and assessments',
  [PERMISSIONS.RESULTS_UPDATE]: 'Amend scores and assessments',
  [PERMISSIONS.RESULTS_PUBLISH]: 'Approve and publish results',
  [PERMISSIONS.USERS_READ]: 'View staff accounts',
  [PERMISSIONS.USERS_CREATE]: 'Invite staff accounts',
  [PERMISSIONS.USERS_UPDATE]: 'Update staff accounts and roles',
  [PERMISSIONS.USERS_DELETE]: 'Revoke staff access',
  [PERMISSIONS.ROLES_READ]: 'View roles and their permissions',
  [PERMISSIONS.ROLES_UPDATE]: 'Change role permissions',
  [PERMISSIONS.SCHOOL_READ]: 'View school profile and settings',
  [PERMISSIONS.SCHOOL_UPDATE]: 'Update school profile and settings',
  [PERMISSIONS.REPORTS_READ]: 'View reports',
  [PERMISSIONS.REPORTS_EXPORT]: 'Export reports',
  [PERMISSIONS.AUDIT_READ]: 'View the audit trail',
  [PERMISSIONS.PORTAL_ACCESS]: 'Access the parent portal for linked students',
};

export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as PermissionKey[];

export function permissionGroup(key: PermissionKey): string {
  return key.split('.')[0];
}
