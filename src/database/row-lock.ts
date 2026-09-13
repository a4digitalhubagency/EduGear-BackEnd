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
