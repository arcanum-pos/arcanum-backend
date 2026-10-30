// Property-based tests (fast-check) for the helpers that read outside input:
// what an admin types in the console, what a guest's phone or the kassa sends.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { readColor } from '../src/branding';
import { readOrder } from '../src/customer-view';
import { normalizePhone } from '../src/messaging';
import { linkNameOf } from '../src/organizations/events';
import { pngSize } from '../src/org-icons';
import { parseTipCents } from '../src/payments/charges';
import { normalizeHost } from '../src/printer-cert';
import { randomCode } from '../src/random';
import { b64url, fromB64url, parseSubscription } from '../src/web-push';

describe('linkNameOf', () => {
  it('only a-z, 0-9 and single inner hyphens, at most 30 characters, never empty, idempotent', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 80 }), (text) => {
        const name = linkNameOf(text);
        expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(name.length).toBeLessThanOrEqual(30);
        expect(linkNameOf(name)).toBe(name);
      }),
    );
  });

  it('keeps the letters of an accented name', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{1,20}$/), (word) => {
        expect(linkNameOf(word.replace(/e/g, 'é').toUpperCase())).toBe(word);
      }),
    );
  });
});

describe('randomCode', () => {
  it('the asked length, only characters of the alphabet', () => {
    fc.assert(
      fc.property(fc.nat({ max: 64 }), fc.string({ minLength: 1, maxLength: 200 }), (length, alphabet) => {
        const code = randomCode(length, alphabet);
        expect(code.length).toBe(length);
        expect([...code].every((c) => alphabet.includes(c))).toBe(true);
      }),
    );
  });
});

describe('normalizePhone', () => {
  const countries = ['+32', '+31'];

  it('anything in, either null or E.164 in an allowed country, idempotent', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.stringMatching(/^(\+|00|0)?[0-9 ./()-]{6,20}$/), fc.anything()), (raw) => {
        const phone = normalizePhone(raw, countries);
        if (phone === null) return;
        expect(phone).toMatch(/^\+\d{8,15}$/);
        expect(countries.some((c) => phone.startsWith(c))).toBe(true);
        expect(normalizePhone(phone, countries)).toBe(phone);
      }),
    );
  });

  it('a Belgian mobile number typed any usual way gives the same E.164', () => {
    const sep = fc.constantFrom('', ' ', '.', '/', '-');
    fc.assert(
      fc.property(fc.stringMatching(/^4\d{8}$/), sep, (digits, s) => {
        const groups = `${digits.slice(0, 3)}${s}${digits.slice(3, 5)}${s}${digits.slice(5, 7)}${s}${digits.slice(7)}`;
        for (const typed of [`0${groups}`, `+32${s}${groups}`, `0032${groups}`]) expect(normalizePhone(typed, countries)).toBe(`+32${digits}`);
      }),
    );
  });
});

describe('readColor', () => {
  it('a colour or null for no colour, undefined for anything else; idempotent', () => {
    fc.assert(
      fc.property(fc.oneof(fc.anything(), fc.stringMatching(/^ ?#[0-9a-fA-F]{6} ?$/)), (value) => {
        const color = readColor(value);
        if (typeof color === 'string') {
          expect(color).toMatch(/^#[0-9a-f]{6}$/);
          expect(readColor(color)).toBe(color);
        } else if (color === null) expect(value === null || value === '').toBe(true);
      }),
    );
  });
});

describe('parseTipCents', () => {
  it('an integer 0..100000 or null, never anything else', () => {
    fc.assert(
      fc.property(fc.oneof(fc.anything(), fc.double(), fc.integer({ min: -10, max: 200_000 })), (raw) => {
        const tip = parseTipCents(raw);
        if (tip !== null) {
          expect(Number.isInteger(tip)).toBe(true);
          expect(tip).toBeGreaterThanOrEqual(0);
          expect(tip).toBeLessThanOrEqual(100_000);
        }
      }),
    );
  });
});

describe('readOrder', () => {
  const line = fc.record({ name: fc.anything(), quantity: fc.anything(), unitPriceCents: fc.anything(), category: fc.anything() }, { requiredKeys: [] });
  const order = fc.record(
    { label: fc.anything(), number: fc.anything(), eventName: fc.anything(), paidCents: fc.anything(), lines: fc.oneof(fc.anything(), fc.array(fc.oneof(line, fc.anything()))) },
    { requiredKeys: [] },
  );

  it('anything the kassa sends: never throws, every field bounded', () => {
    fc.assert(
      fc.property(fc.oneof(fc.anything(), order), (value) => {
        const o = readOrder(value);
        if (!o) return;
        expect(typeof o.label).toBe('string');
        expect(o.label.length).toBeLessThanOrEqual(80);
        expect(Number.isInteger(o.paidCents) && o.paidCents >= 0).toBe(true);
        expect(o.lines.length).toBeLessThanOrEqual(300);
        for (const l of o.lines) {
          expect(Number.isInteger(l.quantity) && l.quantity >= 1 && l.quantity <= 100_000).toBe(true);
          expect(Number.isInteger(l.unitPriceCents)).toBe(true);
          expect(l.name.length).toBeLessThanOrEqual(120);
        }
      }),
    );
  });
});

describe('printer hosts', () => {
  it('normalizeHost gives one form for however an IPv6 address is written, and is idempotent', () => {
    // fast-check's IPv6 addresses, without the IPv4-in-IPv6 forms (a printer has none).
    const ipv6 = fc.ipV6().filter((a) => !a.includes('.'));
    fc.assert(
      fc.property(ipv6, fc.boolean(), (address, upper) => {
        const host = normalizeHost(address);
        expect(host.split(':')).toHaveLength(8);
        expect(normalizeHost(`[${upper ? address.toUpperCase() : address}]`)).toBe(host);
        expect(normalizeHost(host)).toBe(host);
      }),
    );
  });

  it('a name or IPv4 address: trimmed lower case, idempotent', () => {
    fc.assert(
      fc.property(fc.oneof(fc.domain(), fc.ipV4()), (name) => {
        const host = normalizeHost(` ${name.toUpperCase()} `);
        expect(host).toBe(name.toLowerCase());
        expect(normalizeHost(host)).toBe(host);
      }),
    );
  });
});

describe('uploaded icons', () => {
  it('pngSize never throws, and reads back the size of any PNG header', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        pngSize(bytes);
      }),
    );
    fc.assert(
      fc.property(fc.nat(), fc.nat(), fc.uint8Array({ maxLength: 16 }), (width, height, rest) => {
        const bytes = new Uint8Array(24 + rest.length);
        bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
        new DataView(bytes.buffer).setUint32(16, width);
        new DataView(bytes.buffer).setUint32(20, height);
        bytes.set(rest, 24);
        expect(pngSize(bytes)).toEqual({ width, height });
      }),
    );
  });
});

describe('web push', () => {
  it('b64url round-trips any bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        expect(b64url(bytes)).toMatch(/^[A-Za-z0-9_-]*$/);
        expect(fromB64url(b64url(bytes))).toEqual(bytes);
      }),
    );
  });

  it('parseSubscription never throws, and only takes an https address of a browser push service', () => {
    const keys = fc.record({ p256dh: fc.oneof(fc.string(), fc.uint8Array({ minLength: 65, maxLength: 65 }).map(b64url)), auth: fc.oneof(fc.string(), fc.uint8Array({ minLength: 16, maxLength: 16 }).map(b64url)) });
    const endpoint = fc.oneof(fc.string(), fc.webUrl(), fc.constantFrom('https://fcm.googleapis.com/fcm/send/x', 'https://web.push.apple.com/abc', 'https://evil.test/fcm.googleapis.com'));
    fc.assert(
      fc.property(fc.oneof(fc.anything(), fc.record({ endpoint, keys })), (raw) => {
        const sub = parseSubscription(raw);
        if (!sub) return;
        const url = new URL(sub.endpoint);
        expect(url.protocol).toBe('https:');
        expect(/(^|\.)(fcm\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.api\.chromecast\.com)$/.test(url.hostname)).toBe(true);
      }),
    );
  });
});
