import { ConfigService } from '@nestjs/config';
import { AppException } from '../common/errors/app.exception';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const config = {
    get: () => ({ passwordMinLength: 10 }),
  } as unknown as ConfigService;

  const service = new PasswordService(config as never);

  it('produces an argon2id hash that never contains the plaintext', async () => {
    const hash = await service.hash('StrongPass123');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('StrongPass123');
  });

  it('salts hashes so identical passwords differ', async () => {
    const [first, second] = await Promise.all([
      service.hash('StrongPass123'),
      service.hash('StrongPass123'),
    ]);
    expect(first).not.toBe(second);
  });

  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await service.hash('StrongPass123');
    await expect(service.verify(hash, 'StrongPass123')).resolves.toBe(true);
    await expect(service.verify(hash, 'StrongPass124')).resolves.toBe(false);
  });

  it('returns false instead of throwing on a corrupt hash', async () => {
    await expect(service.verify('not-a-hash', 'StrongPass123')).resolves.toBe(
      false,
    );
  });

  it('rejects passwords that are too short or lack a digit or letter', () => {
    expect(() => service.assertMeetsPolicy('Short1')).toThrow(AppException);
    expect(() => service.assertMeetsPolicy('alllettershere')).toThrow(
      AppException,
    );
    expect(() => service.assertMeetsPolicy('1234567890123')).toThrow(
      AppException,
    );
  });

  it('accepts a password that meets the policy', () => {
    expect(() => service.assertMeetsPolicy('StrongPass123')).not.toThrow();
  });
});
