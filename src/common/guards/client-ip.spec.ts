import { normaliseIp, resolveTracker } from './client-ip';

const SECRET = 'a'.repeat(48);
const OTHER = 'b'.repeat(48);

const base = {
  clientIp: '102.89.68.254',
  edgeSecret: SECRET,
  socketIp: '10.0.0.7',
  configuredSecret: SECRET,
};

describe('resolveTracker', () => {
  it('uses the forwarded address when the secret matches', () => {
    expect(resolveTracker(base)).toBe('fwd:102.89.68.254');
  });

  it('gives two clients behind one front end separate budgets', () => {
    const a = resolveTracker({ ...base, clientIp: '102.89.68.254' });
    const b = resolveTracker({ ...base, clientIp: '197.210.1.9' });
    expect(a).not.toBe(b);
  });

  it('ignores the header when no secret is configured', () => {
    expect(resolveTracker({ ...base, configuredSecret: undefined })).toBe(
      'ip:10.0.0.7',
    );
  });

  it('ignores the header when the secret is wrong', () => {
    expect(resolveTracker({ ...base, edgeSecret: OTHER })).toBe('ip:10.0.0.7');
  });

  it('ignores the header when the secret is missing', () => {
    expect(resolveTracker({ ...base, edgeSecret: undefined })).toBe(
      'ip:10.0.0.7',
    );
  });

  it('ignores a secret that is a prefix of the real one', () => {
    expect(resolveTracker({ ...base, edgeSecret: SECRET.slice(0, 20) })).toBe(
      'ip:10.0.0.7',
    );
  });

  it('falls back when the claimed address is not an address', () => {
    for (const clientIp of [
      'not-an-ip',
      '',
      '   ',
      '999.999.999.999',
      42,
      null,
      {},
    ]) {
      expect(resolveTracker({ ...base, clientIp })).toBe('ip:10.0.0.7');
    }
  });

  it('refuses a forwarded-for style chain', () => {
    expect(
      resolveTracker({ ...base, clientIp: '102.89.68.254, 46.151.193.241' }),
    ).toBe('ip:10.0.0.7');
  });

  it('keeps forwarded and socket keys in separate namespaces', () => {
    // Without the prefix, an attacker connecting from 102.89.68.254 would
    // share — and could exhaust — the budget of a real user at that address.
    const forwarded = resolveTracker({ ...base, clientIp: '102.89.68.254' });
    const direct = resolveTracker({
      ...base,
      configuredSecret: undefined,
      socketIp: '102.89.68.254',
    });
    expect(forwarded).not.toBe(direct);
  });

  it('still produces a key when there is no socket address at all', () => {
    expect(
      resolveTracker({
        ...base,
        configuredSecret: undefined,
        socketIp: undefined,
      }),
    ).toBe('ip:unknown');
  });

  it('accepts an IPv6 client', () => {
    expect(resolveTracker({ ...base, clientIp: '2001:db8::1' })).toBe(
      'fwd:2001:db8::1',
    );
  });
});

describe('normaliseIp', () => {
  it('unwraps an IPv4-mapped IPv6 address', () => {
    expect(normaliseIp('::ffff:102.89.68.254')).toBe('102.89.68.254');
  });

  it('strips an IPv6 zone index', () => {
    expect(normaliseIp('fe80::1%eth0')).toBe('fe80::1');
  });

  it('lower-cases so one address is one key', () => {
    expect(normaliseIp('2001:DB8::1')).toBe('2001:db8::1');
  });

  it('trims surrounding whitespace', () => {
    expect(normaliseIp('  10.0.0.7  ')).toBe('10.0.0.7');
  });

  it('rejects an over-long value rather than keying on it', () => {
    expect(normaliseIp('1'.repeat(200))).toBeNull();
  });

  it('rejects anything that is not an address', () => {
    expect(normaliseIp('localhost')).toBeNull();
    expect(normaliseIp(undefined)).toBeNull();
  });
});
