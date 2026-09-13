import { Prisma } from '@prisma/client';

/** A mark as printed: two decimal places, as a plain number for the DTO. */
export function mark(value: Prisma.Decimal | number): number {
  return new Prisma.Decimal(value).toDecimalPlaces(2).toNumber();
}
