import { formatReceiptNumber, nextReceiptSequence } from './receipt-number';

describe('formatReceiptNumber', () => {
  it('pads to six digits', () => {
    expect(formatReceiptNumber(2025, 1)).toBe('RCP/2025/000001');
  });

  it('does not truncate a school past six digits', () => {
    expect(formatReceiptNumber(2025, 1234567)).toBe('RCP/2025/1234567');
  });
});

describe('formatReceiptNumber with a school prefix', () => {
  it('uses the prefix it is given', () => {
    expect(formatReceiptNumber(2025, 7, 'BSC')).toBe('BSC/2025/000007');
  });
});

describe('nextReceiptSequence', () => {
  it('starts at 1', () => {
    expect(nextReceiptSequence([], 2025)).toBe(1);
  });

  it('continues from the highest issued', () => {
    expect(
      nextReceiptSequence(['RCP/2025/000001', 'RCP/2025/000009'], 2025),
    ).toBe(10);
  });

  it('restarts each year', () => {
    expect(nextReceiptSequence(['RCP/2024/000500'], 2025)).toBe(1);
  });

  it('continues the sequence when the prefix changes', () => {
    expect(
      nextReceiptSequence(['RCP/2025/000004', 'BSC/2025/000005'], 2025),
    ).toBe(6);
  });

  it('ignores anything off-pattern', () => {
    expect(nextReceiptSequence(['legacy-7', 'RCP/2025/000002'], 2025)).toBe(3);
  });
});
