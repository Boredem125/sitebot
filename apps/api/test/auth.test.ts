import { describe, expect, it } from 'vitest';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../src/auth';

describe('password hashing', () => {
  it('round-trips and stores the documented format', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse batterz', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('salts: two hashes of the same password differ and both verify', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('returns false for malformed stored values instead of throwing', async () => {
    const good = await hashPassword('pw-12345678');
    const [, , salt, hash] = good.split('$');
    const malformed = [
      '',
      'x',
      'plaintext-password',
      'pbkdf2$100000$only-three',
      `bcrypt$100000$${salt}$${hash}`,
      `pbkdf2$abc$${salt}$${hash}`,
      `pbkdf2$0$${salt}$${hash}`,
      `pbkdf2$99999999$${salt}$${hash}`,
      `pbkdf2$100000$!!not-base64!!$${hash}`,
      `pbkdf2$100000$${salt}$!!not-base64!!`,
      `pbkdf2$100000$${salt}$${btoa('short')}`,
      `${good}$extra`,
    ];
    for (const stored of malformed) {
      expect(await verifyPassword('pw-12345678', stored)).toBe(false);
    }
    expect(await verifyPassword('pw-12345678', null as unknown as string)).toBe(false);
  });

  it('the dummy hash is well formed but matches nothing', async () => {
    expect(DUMMY_PASSWORD_HASH).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword('', DUMMY_PASSWORD_HASH)).toBe(false);
    expect(await verifyPassword('password', DUMMY_PASSWORD_HASH)).toBe(false);
  });
});
