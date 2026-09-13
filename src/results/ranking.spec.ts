import { Prisma } from '@prisma/client';
import { competitionRank, ordinal } from './ranking';

const d = (value: number | string) => new Prisma.Decimal(value);

describe('competitionRank', () => {
  const rank = (values: (number | string)[]) => {
    const items = values.map((value, index) => ({ index, value: d(value) }));
    const ranks = competitionRank(items, (item) => item.value);
    return items.map((item) => ranks.get(item));
  };

  it('ranks highest first', () => {
    expect(rank([60, 90, 75])).toEqual([3, 1, 2]);
  });

  it('shares a place on a tie and skips the next', () => {
    // 90, 80, 80, 70 → 1st, 2nd, 2nd, 4th
    expect(rank([90, 80, 80, 70])).toEqual([1, 2, 2, 4]);
  });

  it('handles a three-way tie at the top', () => {
    expect(rank([85, 85, 85, 60])).toEqual([1, 1, 1, 4]);
  });

  it('treats averages that print the same as tied', () => {
    // Both print as 66.67.
    expect(rank(['66.666', '66.674'])).toEqual([1, 1]);
  });

  it('separates averages that print differently', () => {
    expect(rank(['66.66', '66.67'])).toEqual([2, 1]);
  });

  it('ranks a single student first', () => {
    expect(rank([40])).toEqual([1]);
  });

  it('is empty for nobody', () => {
    expect(competitionRank([], () => d(0)).size).toBe(0);
  });
});

describe('ordinal', () => {
  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [23, '23rd'],
    [101, '101st'],
    [111, '111th'],
    [113, '113th'],
  ])('%p → %p', (position, expected) => {
    expect(ordinal(position)).toBe(expected);
  });
});
