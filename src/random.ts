// Random codes from an alphabet (pairing codes, table QR tokens, event
// links). Rejection sampling: bytes past the last whole multiple of the
// alphabet's length are skipped, so every character is equally likely - a
// plain `byte % length` would favour the first few characters.
export function randomCode(length: number, alphabet: string): string {
  const limit = 256 - (256 % alphabet.length);
  let code = '';
  while (code.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length + 8))) {
      if (byte < limit && code.length < length) code += alphabet[byte % alphabet.length];
    }
  }
  return code;
}
