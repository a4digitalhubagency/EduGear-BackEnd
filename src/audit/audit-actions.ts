/** Canonical audit action names: `<entity>.<verb>`, past tense where it reads better. */
export const AUDIT_ACTIONS = {
  // Authentication
  AUTH_LOGIN_SUCCEEDED: 'auth.login.succeeded',
  AUTH_LOGIN_FAILED: 'auth.login.failed',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_LOGOUT_ALL: 'auth.logout_all',
  AUTH_TOKEN_REFRESHED: 'auth.token.refreshed',
  AUTH_TOKEN_REUSE_DETECTED: 'auth.token.reuse_detected',
  AUTH_SCHOOL_SWITCHED: 'auth.school.switched',
  AUTH_PASSWORD_CHANGED: 'auth.password.changed',
  AUTH_PASSWORD_RESET_REQUESTED: 'auth.password.reset_requested',
  AUTH_PASSWORD_RESET_COMPLETED: 'auth.password.reset_completed',
  AUTH_EMAIL_VERIFIED: 'auth.email.verified',
  AUTH_ACCOUNT_LOCKED: 'auth.account.locked',

  // Tenant lifecycle
  SCHOOL_REGISTERED: 'school.registered',
  SCHOOL_UPDATED: 'school.updated',

  // Users and access
  USER_INVITED: 'user.invited',
  USER_INVITATION_ACCEPTED: 'user.invitation.accepted',
  USER_UPDATED: 'user.updated',
  USER_ROLE_CHANGED: 'user.role.changed',
  USER_SUSPENDED: 'user.suspended',
  USER_REACTIVATED: 'user.reactivated',
  USER_ACCESS_REVOKED: 'user.access.revoked',
  ROLE_PERMISSIONS_UPDATED: 'role.permissions.updated',

  // Phase 1+ domains (names reserved so log queries stay stable)
  STUDENT_CREATED: 'student.created',
  STUDENT_UPDATED: 'student.updated',
  STUDENT_DEACTIVATED: 'student.deactivated',
  FEE_STRUCTURE_CREATED: 'fee_structure.created',
  PAYMENT_RECORDED: 'payment.recorded',
  PAYMENT_VERIFIED: 'payment.verified',
  PAYMENT_REJECTED: 'payment.rejected',
  RESULT_CREATED: 'result.created',
  RESULT_PUBLISHED: 'result.published',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
