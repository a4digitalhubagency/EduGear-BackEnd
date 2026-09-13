import { Prisma } from '@prisma/client';
import { amountInWords, integerToWords } from './amount-in-words';

const words = (value: string) => amountInWords(new Prisma.Decimal(value));

describe('integerToWords', () => {
  it.each([
    [0, 'zero'],
    [7, 'seven'],
    [15, 'fifteen'],
    [40, 'forty'],
    [45, 'forty-five'],
    [100, 'one hundred'],
    [105, 'one hundred and five'],
    [999, 'nine hundred and ninety-nine'],
    [1000, 'one thousand'],
    [1005, 'one thousand and five'],
    [1050, 'one thousand and fifty'],
    [1100, 'one thousand one hundred'],
    [50000, 'fifty thousand'],
    [150050, 'one hundred and fifty thousand and fifty'],
    [1000000, 'one million'],
    [2500000, 'two million five hundred thousand'],
    [1000001, 'one million and one'],
  ])('%p → %p', (value, expected) => {
    expect(integerToWords(value)).toBe(expected);
  });
});

describe('amountInWords', () => {
  it('writes whole naira', () => {
    expect(words('50000')).toBe('Fifty thousand naira only');
  });

  it('writes kobo', () => {
    expect(words('150050.50')).toBe(
      'One hundred and fifty thousand and fifty naira, fifty kobo only',
    );
  });

  it('writes a single kobo', () => {
    expect(words('0.01')).toBe('Zero naira, one kobo only');
  });

  it('rounds to kobo rather than truncating', () => {
    expect(words('10.999')).toBe('Eleven naira only');
  });
});
