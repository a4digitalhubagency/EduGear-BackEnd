import { Prisma } from '@prisma/client';

/**
 * "₦150,050.50" → "One hundred and fifty thousand and fifty naira, fifty kobo only".
 *
 * Receipts in Nigeria carry the amount in words as well as figures — it is the
 * figure a parent cannot quietly alter. British usage ("and" before the tens)
 * is what schools and banks here write.
 */
const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  return n % 10 === 0 ? tens : `${tens}-${ONES[n % 10]}`;
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds === 0) return belowHundred(rest);
  const head = `${ONES[hundreds]} hundred`;
  return rest === 0 ? head : `${head} and ${belowHundred(rest)}`;
}

/** Whole numbers only; the caller splits naira from kobo. */
export function integerToWords(value: number): string {
  if (value === 0) return 'zero';

  const groups: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    groups.push(remaining % 1000);
    remaining = Math.floor(remaining / 1000);
  }

  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (group === 0) continue;
    const words = belowThousand(group);
    // "one thousand and five": a trailing group under 100 takes an "and".
    const joiner = i === 0 && parts.length > 0 && group < 100 ? 'and ' : '';
    parts.push(`${joiner}${words}${SCALES[i] ? ` ${SCALES[i]}` : ''}`);
  }

  return parts.join(' ');
}

export function amountInWords(amount: Prisma.Decimal): string {
  const rounded = amount.toDecimalPlaces(2);
  const naira = rounded.floor().toNumber();
  const kobo = rounded.sub(rounded.floor()).mul(100).round().toNumber();

  const nairaWords = `${integerToWords(naira)} naira`;
  const koboWords = kobo > 0 ? `, ${integerToWords(kobo)} kobo` : '';
  const sentence = `${nairaWords}${koboWords} only`;

  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
