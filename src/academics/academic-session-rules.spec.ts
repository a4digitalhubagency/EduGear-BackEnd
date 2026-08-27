import { validateSessionName } from './academic-session-rules';

describe('validateSessionName', () => {
  it('accepts two consecutive years', () => {
    expect(validateSessionName('2025/2026')).toBeNull();
  });

  it.each(['2025', '2025-2026', '25/26', 'Session One', '2025/2026 '])(
    'rejects %p',
    (name) => {
      expect(validateSessionName(name)).toMatch(/must look like/);
    },
  );

  it('rejects a gap between the years, which is always a typo', () => {
    expect(validateSessionName('2025/2027')).toMatch(/consecutive/);
  });

  it('rejects a backwards range', () => {
    expect(validateSessionName('2026/2025')).toMatch(/consecutive/);
  });
});
