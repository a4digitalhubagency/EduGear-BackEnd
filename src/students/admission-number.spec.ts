import { formatAdmissionNumber, nextSequence } from './admission-number';

describe('formatAdmissionNumber', () => {
  it('pads the sequence to four digits', () => {
    expect(formatAdmissionNumber(2025, 1)).toBe('2025/0001');
    expect(formatAdmissionNumber(2025, 42)).toBe('2025/0042');
  });

  it('does not truncate a school that passes four digits', () => {
    expect(formatAdmissionNumber(2025, 12345)).toBe('2025/12345');
  });

  it('puts the school’s prefix in front when it has one', () => {
    expect(formatAdmissionNumber(2025, 1, 'BSC')).toBe('BSC/2025/0001');
    expect(formatAdmissionNumber(2025, 1, null)).toBe('2025/0001');
  });
});

describe('nextSequence', () => {
  it('starts at 1 for a year with no students', () => {
    expect(nextSequence([], 2025)).toBe(1);
  });

  it('continues from the highest used number', () => {
    expect(nextSequence(['2025/0001', '2025/0007', '2025/0003'], 2025)).toBe(8);
  });

  it('ignores other years', () => {
    expect(nextSequence(['2024/0009', '2025/0002'], 2025)).toBe(3);
  });

  it('ignores hand-typed numbers rather than guessing at them', () => {
    expect(nextSequence(['ADM-17', 'BSC/2025/4', '2025/0002'], 2025)).toBe(3);
  });

  it('continues the year’s sequence when the prefix changes', () => {
    // The school added a "BSC" prefix after admitting two students.
    expect(nextSequence(['2025/0001', 'BSC/2025/0002'], 2025)).toBe(3);
  });

  it('is unaffected by a gap in the sequence', () => {
    expect(nextSequence(['2025/0001', '2025/0050'], 2025)).toBe(51);
  });
});
