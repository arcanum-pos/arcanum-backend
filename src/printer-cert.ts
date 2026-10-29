// A push printer's own certificate (arcanum/PRINTING.md, "Trusting a push
// printer"): read just enough of it to check it is that printer's, and to
// say up front when Apple devices won't accept it. No signature checks - a
// self-signed certificate proves nothing by itself; what matters is that
// the command uploading it was given a one-time code by a signed-in screen.

export interface PrinterCertificate {
  der: Uint8Array;
  selfSigned: boolean;
  isCa: boolean;
  commonName: string | null;
  dnsNames: string[];
  ipAddresses: string[];
  notBefore: Date | null;
  notAfter: Date | null;
}

// PEM ("-----BEGIN CERTIFICATE-----") or its bare base64 (DER).
export function pemToDer(text: string): Uint8Array | null {
  const pem = text.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  const b64 = (pem ? pem[1] : text).replace(/\s+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) return null;
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function derToPem(der: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
}

export const toBase64 = (der: Uint8Array) => btoa(String.fromCharCode(...der));

// --- DER ---

interface Tlv {
  tag: number;
  start: number; // the contents
  end: number;
}

function read(buf: Uint8Array, at: number, limit = buf.length): Tlv {
  if (at + 2 > limit) throw new Error('short');
  const tag = buf[at];
  let len = buf[at + 1];
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 3 || start + n > limit) throw new Error('length');
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[start + i];
    start += n;
  }
  if (start + len > limit) throw new Error('long');
  return { tag, start, end: start + len };
}

function children(buf: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let at = parent.start; at < parent.end; ) {
    const t = read(buf, at, parent.end);
    out.push(t);
    at = t.end;
  }
  return out;
}

const bytes = (buf: Uint8Array, t: Tlv) => buf.subarray(t.start, t.end);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const OID_CN = [0x55, 0x04, 0x03];
const OID_SAN = [0x55, 0x1d, 0x11];
const OID_BASIC = [0x55, 0x1d, 0x13];
const isOid = (buf: Uint8Array, t: Tlv, oid: number[]) => t.tag === 0x06 && same(bytes(buf, t), Uint8Array.from(oid));
const text = (buf: Uint8Array, t: Tlv) => new TextDecoder().decode(bytes(buf, t));

function time(buf: Uint8Array, t: Tlv): Date | null {
  const s = text(buf, t);
  const m = t.tag === 0x17 ? s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/) : s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/);
  if (!m) return null;
  const year = t.tag === 0x17 ? (Number(m[1]) < 50 ? 2000 : 1900) + Number(m[1]) : Number(m[1]);
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0)));
}

function ip(raw: Uint8Array): string | null {
  if (raw.length === 4) return [...raw].join('.');
  if (raw.length === 16) return [...Array(8)].map((_, i) => ((raw[2 * i] << 8) | raw[2 * i + 1]).toString(16)).join(':');
  return null;
}

// The common name in a Name (SEQUENCE OF SET OF SEQUENCE { oid, value }).
function commonName(buf: Uint8Array, name: Tlv): string | null {
  for (const set of children(buf, name)) {
    for (const atv of children(buf, set)) {
      const [oid, value] = children(buf, atv);
      if (oid && value && isOid(buf, oid, OID_CN)) return text(buf, value);
    }
  }
  return null;
}

export function parseCertificate(der: Uint8Array): PrinterCertificate | null {
  try {
    const cert = read(der, 0);
    if (cert.tag !== 0x30 || cert.end !== der.length) return null;
    const tbs = children(der, cert)[0];
    let fields = children(der, tbs);
    if (fields[0]?.tag === 0xa0) fields = fields.slice(1); // [0] version
    const [, , issuer, validity, subject] = fields;
    if (!issuer || !validity || !subject) return null;
    const [notBefore, notAfter] = children(der, validity);
    const out: PrinterCertificate = {
      der,
      selfSigned: same(bytes(der, issuer), bytes(der, subject)),
      isCa: false,
      commonName: commonName(der, subject),
      dnsNames: [],
      ipAddresses: [],
      notBefore: notBefore ? time(der, notBefore) : null,
      notAfter: notAfter ? time(der, notAfter) : null,
    };
    const extensions = fields.find((f) => f.tag === 0xa3);
    if (extensions) {
      for (const ext of children(der, children(der, extensions)[0])) {
        const parts = children(der, ext);
        const oid = parts[0];
        const value = parts[parts.length - 1];
        if (!oid || value?.tag !== 0x04) continue;
        const inner = read(der, value.start, value.end);
        if (isOid(der, oid, OID_SAN)) {
          for (const name of children(der, inner)) {
            if (name.tag === 0x82) out.dnsNames.push(text(der, name).toLowerCase());
            if (name.tag === 0x87) {
              const address = ip(bytes(der, name));
              if (address) out.ipAddresses.push(address);
            }
          }
        }
        if (isOid(der, oid, OID_BASIC)) {
          const first = children(der, inner)[0];
          out.isCa = !!first && first.tag === 0x01 && der[first.start] !== 0;
        }
      }
    }
    return out;
  } catch {
    return null;
  }
}

// A host as typed in the console, compared the way the certificate says it:
// an IPv4/IPv6 address in its canonical form, a name in lower case.
export function normalizeHost(host: string): string {
  const h = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!h.includes(':')) return h;
  // IPv6: expand "::" and drop leading zeros.
  const [head, tail] = h.split('::');
  const a = head ? head.split(':') : [];
  const b = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? a : [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
  return groups.map((g) => parseInt(g || '0', 16).toString(16)).join(':');
}

export const isIp = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');

// What the certificate names, and whether that includes the printer.
export function namesHost(cert: PrinterCertificate, host: string): { inSan: boolean; inCn: boolean } {
  const h = normalizeHost(host);
  const san = isIp(h) ? cert.ipAddresses.map(normalizeHost) : cert.dnsNames;
  return { inSan: san.includes(h), inCn: !!cert.commonName && normalizeHost(cert.commonName) === h };
}

// Apple's rules for a TLS server certificate (support.apple.com/HT210176):
// valid at most 825 days, and the name in the Subject Alternative Name.
export const APPLE_MAX_DAYS = 825;

export async function fingerprint(der: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', der);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const showFingerprint = (hex: string) => hex.toUpperCase().match(/.{2}/g)!.join(':');

// A UUID made from text, so the same printer and certificate always give
// the same profile (installing it again replaces it).
export async function stableUuid(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).slice(0, 16);
  d[6] = (d[6] & 0x0f) | 0x50;
  d[8] = (d[8] & 0x3f) | 0x80;
  const h = [...d].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const plist = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);

// An Apple configuration profile with the certificate as a root: installed
// in Settings, then trusted under General → About → Certificate Trust Settings.
export async function mobileconfig(p: { printerId: string; printerName: string; orgName: string; der: Uint8Array; fingerprint: string; description: string }): Promise<string> {
  const id = `be.kaboutersoft.arcanum.printer.${p.printerId.replace(/[^A-Za-z0-9-]/g, '')}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>printer.cer</string>
      <key>PayloadContent</key>
      <data>${toBase64(p.der)}</data>
      <key>PayloadDescription</key>
      <string>${plist(p.description)}</string>
      <key>PayloadDisplayName</key>
      <string>${plist(p.printerName)}</string>
      <key>PayloadIdentifier</key>
      <string>${id}.certificate</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${await stableUuid(`${p.printerId}:${p.fingerprint}`)}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>${plist(p.description)}</string>
  <key>PayloadDisplayName</key>
  <string>${plist(`${p.printerName} (${p.orgName})`)}</string>
  <key>PayloadIdentifier</key>
  <string>${id}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${await stableUuid(p.printerId)}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}
