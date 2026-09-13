import { Prisma } from '@prisma/client';

/**
 * Standard competition ranking — "1st, 2nd, 2nd, 4th" — which is how Nigerian
 * report cards place tied students: both share the place, and the next student
 * takes the place their rank actually is, not the next integer.
 *
 * Values are compared at two decimal places, the precision a report card
 * prints: two averages that print the same must rank the same.
 */
export function competitionRank<T>(
  items: readonly T[],
  value: (item: T) => Prisma.Decimal,
): Map<T, number> {
  const sorted = [...items].sort((a, b) =>
    value(b).toDecimalPlaces(2).comparedTo(value(a).toDecimalPlaces(2)),
  );

  const ranks = new Map<T, number>();
  let previous: Prisma.Decimal | null = null;
  let rank = 0;

  sorted.forEach((item, index) => {
    const current = value(item).toDecimalPlaces(2);
    if (previous === null || !current.equals(previous)) {
      rank = index + 1;
      previous = current;
    }
    ranks.set(item, rank);
  });

  return ranks;
}

/** 1 → "1st", 2 → "2nd", 11 → "11th", 22 → "22nd", 113 → "113th". */
export function ordinal(position: number): string {
  const lastTwo = position % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${position}th`;
  switch (position % 10) {
    case 1:
      return `${position}st`;
    case 2:
      return `${position}nd`;
    case 3:
      return `${position}rd`;
    default:
      return `${position}th`;
  }
}
