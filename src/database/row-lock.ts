import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  RequestContext,
  TenantContextMissingError,
} from '../common/context/request-context';
import { TxClient } from './prisma.service';

/**
 * Pessimistic row locks for check-then-write sequences.
 *
 * "Is there room in this arm?" followed by "add the student" is only correct if
 * nobody else can add a student in between. `SELECT … FOR UPDATE` inside the
 * same transaction makes a second writer wait until the first commits, and then
 * see its effect — the only reliable way to enforce a limit that spans rows.
 *
 * `$queryRaw` bypasses the tenant guard, so this scopes by `schoolId` itself,
 * and the table name comes only from this fixed map, never from input.
 */
const LOCKABLE_TABLES = {
  classArm: 'class_arms',
  studentFee: 'student_fees',
  resultSheet: 'result_sheets',
} as const;

export type LockableModel = keyof typeof LOCKABLE_TABLES;

/** Locks one row for the rest of the transaction. False when it does not exist. */
export async function lockRow(
  tx: TxClient,
  model: LockableModel,
  id: string,
): Promise<boolean> {
  const schoolId = RequestContext.getTenantId();
  if (!schoolId) {
    throw new TenantContextMissingError(model, 'lockRow');
  }

  const table = Prisma.raw(`"${LOCKABLE_TABLES[model]}"`);
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM ${table}
    WHERE id = ${id}::uuid AND "schoolId" = ${schoolId}::uuid
    FOR UPDATE`;

  return rows.length > 0;
}

/**
 * Locks several rows in a deterministic order. Two transactions locking the
 * same set in different orders is the textbook deadlock; sorting removes it.
 */
export async function lockRows(
  tx: TxClient,
  model: LockableModel,
  ids: Iterable<string>,
): Promise<string[]> {
  const missing: string[] = [];
  for (const id of [...new Set(ids)].sort()) {
    if (!(await lockRow(tx, model, id))) missing.push(id);
  }
  return missing;
}

/**
 * Scopes that need a lock spanning rows rather than one row: a storage quota is
 * a sum over every file, so there is no single row to lock. A transaction-level
 * advisory lock serialises the check-then-insert for one school without touching
 * the rows themselves.
 */
const ADVISORY_SCOPES = { storageQuota: 'edugear:storage-quota' } as const;

export type AdvisoryScope = keyof typeof ADVISORY_SCOPES;

/**
 * Derived in JavaScript rather than with Postgres' `hashtext`, which is an
 * internal function with no compatibility promise. The first 8 bytes of a SHA-256
 * read as a signed 64-bit integer, which is what the lock takes.
 */
function advisoryKey(value: string): bigint {
  const digest = createHash('sha256').update(value).digest();
  return digest.readBigInt64BE(0);
}

/**
 * The key `lockSchoolScope` will use. Exported so a test can hold the same lock
 * from outside and prove that one school's writes serialise while another's do
 * not — the property the whole quota check rests on.
 */
export function advisoryLockKey(
  scope: AdvisoryScope,
  schoolId: string,
): bigint {
  return advisoryKey(`${ADVISORY_SCOPES[scope]}:${schoolId}`);
}

/**
 * Serialises one school's writes within `scope` for the rest of the transaction.
 * Waits rather than failing, exactly as `FOR UPDATE` does.
 */
export async function lockSchoolScope(
  tx: TxClient,
  scope: AdvisoryScope,
  schoolId: string,
): Promise<void> {
  const key = advisoryKey(`${ADVISORY_SCOPES[scope]}:${schoolId}`);
  // `$executeRaw`, not `$queryRaw`: the function returns void, which has no
  // Prisma type to deserialize into.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`;
}
