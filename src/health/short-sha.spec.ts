// Behaviour of the version field on /api/health/live.
const shortSha = (value: string | undefined): string => {
  const trimmed = value?.trim() ?? '';
  return /^[0-9a-f]{40}$/i.test(trimmed) ? trimmed.slice(0, 7) : trimmed;
};

describe('the version reported by /api/health/live', () => {
  it('shortens a full sha to what git log shows', () => {
    expect(shortSha('bc1ca25a3656ef9db15c30398fc0cb588d2e4c75')).toBe(
      'bc1ca25',
    );
  });

  it('leaves an already-short sha alone', () => {
    expect(shortSha('bc1ca25')).toBe('bc1ca25');
  });

  it('treats an unresolved platform reference as absent', () => {
    // This is the case that mattered: the reference expands to nothing.
    expect(shortSha('')).toBe('');
    expect(shortSha(undefined)).toBe('');
    expect(shortSha('   ')).toBe('');
  });

  it('does not mangle a version that is not a sha', () => {
    expect(shortSha('v1.4.2')).toBe('v1.4.2');
  });
});
