import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomCode } from '../src/random';

describe('randomCode', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the asked length, only characters of the alphabet', () => {
    for (let i = 0; i < 50; i++) expect(randomCode(20, 'abc23')).toMatch(/^[abc23]{20}$/);
  });

  it('skips the bytes that would favour the first characters (no modulo bias)', () => {
    // 31 characters: 248 is the last whole multiple, so 248..255 are skipped.
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(((bytes: Uint8Array) => {
      bytes.fill(255);
      bytes[3] = 0;
      bytes[5] = 247;
      return bytes;
    }) as typeof crypto.getRandomValues);
    expect(randomCode(2, alphabet)).toBe(`a${alphabet[247 % 31]}`);
  });
});
