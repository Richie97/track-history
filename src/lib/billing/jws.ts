// Minimal JWS + X.509 verification for the App Store's signed payloads.
//
// StoreKit 2 hands the app a JWS whose header carries the signing certificate
// chain (`x5c`: leaf, intermediate, root). Verifying it means: the chain ends in
// a root we pin, each certificate is signed by the one after it, the
// intermediate and leaf carry the two Apple-specific extension OIDs (any cert
// Apple issues chains to the same root — a developer certificate included — so
// the OIDs are what make it a *receipt signer*), the leaf is within its validity
// at the payload's signing time, and the JWS signature verifies under the leaf's
// key. That is what Apple's own App Store Server Library does; this is the
// dependency-free WebCrypto version, since the Worker has no `node:crypto`.
//
// Only what Apple actually uses is implemented: ECDSA certificates on P-256 and
// P-384, signed with SHA-256 or SHA-384, and ES256 JWS. Anything else is a
// verification failure, never a fallback.

export class JwsError extends Error {}

// ---------------------------------------------------------------------------
// base64 helpers
// ---------------------------------------------------------------------------

export function base64UrlDecode(input: string): Uint8Array {
  const b64 = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
}

export function base64Decode(input: string): Uint8Array {
  return Uint8Array.from(atob(input), (ch) => ch.charCodeAt(0));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new JwsError("malformed JWS segment");
  }
}

// ---------------------------------------------------------------------------
// DER
// ---------------------------------------------------------------------------

type Der = { tag: number; start: number; end: number; contentStart: number; bytes: Uint8Array };

// Parses one TLV at `offset`, returning its boundaries. Constructed types are
// walked with `children`.
function readDer(bytes: Uint8Array, offset: number): Der {
  if (offset + 2 > bytes.length) throw new JwsError("truncated DER");
  const tag = bytes[offset];
  let len = bytes[offset + 1];
  let p = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > bytes.length) throw new JwsError("bad DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + bytes[p++];
  }
  if (p + len > bytes.length) throw new JwsError("truncated DER");
  return { tag, start: offset, end: p + len, contentStart: p, bytes };
}

function children(node: Der): Der[] {
  const out: Der[] = [];
  let p = node.contentStart;
  while (p < node.end) {
    const child = readDer(node.bytes, p);
    out.push(child);
    p = child.end;
  }
  return out;
}

const content = (node: Der) => node.bytes.subarray(node.contentStart, node.end);
const whole = (node: Der) => node.bytes.subarray(node.start, node.end);

function oidToString(node: Der): string {
  const b = content(node);
  if (b.length === 0) return "";
  const parts = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

// UTCTime (YYMMDDHHMMSSZ) or GeneralizedTime (YYYYMMDDHHMMSSZ) → epoch ms.
function derTime(node: Der): number {
  const s = new TextDecoder().decode(content(node));
  const m =
    node.tag === 0x17
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)
      : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/.exec(s);
  if (!m) throw new JwsError("bad certificate time");
  let year = Number(m[1]);
  if (node.tag === 0x17) year += year >= 50 ? 1900 : 2000;
  return Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

// ---------------------------------------------------------------------------
// X.509
// ---------------------------------------------------------------------------

const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const CURVES: Record<string, { name: string; coordBytes: number }> = {
  "1.2.840.10045.3.1.7": { name: "P-256", coordBytes: 32 },
  "1.3.132.0.34": { name: "P-384", coordBytes: 48 },
};
const SIG_ALGS: Record<string, string> = {
  "1.2.840.10045.4.3.2": "SHA-256", // ecdsa-with-SHA256
  "1.2.840.10045.4.3.3": "SHA-384", // ecdsa-with-SHA384
};
const OID_EXTENSIONS_TAG = 0xa3; // [3] EXPLICIT Extensions

// The two Apple-specific marks the App Store Server Library requires.
export const APPLE_OID_WWDR_INTERMEDIATE = "1.2.840.113635.100.6.2.1";
export const APPLE_OID_RECEIPT_SIGNING = "1.2.840.113635.100.6.11.1";

export type Certificate = {
  der: Uint8Array;
  tbs: Uint8Array;
  signatureHash: string;
  signature: Uint8Array; // DER-encoded ECDSA-Sig-Value
  spki: Uint8Array;
  curve: { name: string; coordBytes: number };
  notBefore: number;
  notAfter: number;
  extensionOids: Set<string>;
};

export function parseCertificate(der: Uint8Array): Certificate {
  const cert = readDer(der, 0);
  if (cert.tag !== 0x30) throw new JwsError("certificate is not a SEQUENCE");
  const [tbs, sigAlg, sigValue] = children(cert);
  if (!tbs || !sigAlg || !sigValue) throw new JwsError("malformed certificate");

  const sigOid = children(sigAlg)[0];
  const signatureHash = sigOid && SIG_ALGS[oidToString(sigOid)];
  if (!signatureHash) throw new JwsError("unsupported certificate signature algorithm");
  const sigBits = content(sigValue);
  if (sigBits[0] !== 0) throw new JwsError("bad signature BIT STRING");

  // tbsCertificate: [0] version, serial, sigAlg, issuer, validity, subject, spki, ... extensions
  const fields = children(tbs);
  let i = 0;
  if (fields[i]?.tag === 0xa0) i++; // explicit version
  const validity = fields[i + 3];
  const spki = fields[i + 5];
  if (!validity || !spki) throw new JwsError("malformed tbsCertificate");
  const [nb, na] = children(validity);
  const [spkiAlg] = children(spki);
  const [keyOid, curveOid] = children(spkiAlg);
  if (!keyOid || oidToString(keyOid) !== OID_EC_PUBLIC_KEY) throw new JwsError("certificate key is not EC");
  const curve = curveOid && CURVES[oidToString(curveOid)];
  if (!curve) throw new JwsError("unsupported EC curve");

  const extensionOids = new Set<string>();
  const extBlock = fields.find((f) => f.tag === OID_EXTENSIONS_TAG);
  if (extBlock) {
    for (const ext of children(children(extBlock)[0])) {
      const oid = children(ext)[0];
      if (oid) extensionOids.add(oidToString(oid));
    }
  }

  return {
    der,
    tbs: whole(tbs),
    signatureHash,
    signature: sigBits.subarray(1),
    spki: whole(spki),
    curve,
    notBefore: derTime(nb),
    notAfter: derTime(na),
    extensionOids,
  };
}

// DER ECDSA-Sig-Value (SEQUENCE of two INTEGERs) → the fixed-width r||s WebCrypto wants.
function derSignatureToRaw(sig: Uint8Array, coordBytes: number): Uint8Array {
  const seq = readDer(sig, 0);
  const [r, s] = children(seq);
  if (!r || !s) throw new JwsError("bad ECDSA signature");
  const out = new Uint8Array(coordBytes * 2);
  for (const [node, offset] of [
    [r, 0],
    [s, coordBytes],
  ] as const) {
    let v = content(node);
    while (v.length > coordBytes && v[0] === 0) v = v.subarray(1);
    if (v.length > coordBytes) throw new JwsError("bad ECDSA signature");
    out.set(v, offset + coordBytes - v.length);
  }
  return out;
}

async function importSpki(cert: Certificate): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", cert.spki, { name: "ECDSA", namedCurve: cert.curve.name }, false, [
    "verify",
  ]);
}

// Is `cert` signed by `issuer`'s key?
async function verifySignedBy(cert: Certificate, issuer: Certificate): Promise<boolean> {
  try {
    const key = await importSpki(issuer);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: cert.signatureHash },
      key,
      derSignatureToRaw(cert.signature, issuer.curve.coordBytes),
      cert.tbs
    );
  } catch {
    return false;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// JWS
// ---------------------------------------------------------------------------

export type VerifyOptions = {
  // Trust anchors, DER. Defaults to the pinned Apple roots at the call site.
  rootsDer: readonly Uint8Array[];
  // The instant the leaf certificate must be valid at. Apple's own library
  // uses the payload's `signedDate` so a transaction signed last year still
  // verifies after its leaf rotated; callers pass that when they have it.
  nowMs?: number;
};

// Verifies an x5c-carrying ES256 JWS and returns its decoded payload. Throws
// JwsError on any failure — there is deliberately no "unverified" return path.
export async function verifyX5cJws(jws: string, opts: VerifyOptions): Promise<Record<string, unknown>> {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new JwsError("malformed JWS");
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodeJsonSegment(headerB64);
  if (header.alg !== "ES256") throw new JwsError("unsupported JWS algorithm");
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length < 2 || x5c.length > 3 || !x5c.every((c) => typeof c === "string"))
    throw new JwsError("JWS carries no certificate chain");

  let chain: Certificate[];
  try {
    chain = (x5c as string[]).map((c) => parseCertificate(base64Decode(c)));
  } catch (err) {
    throw err instanceof JwsError ? err : new JwsError("malformed certificate chain");
  }
  const leaf = chain[0];
  const intermediate = chain[1];
  const root = chain[chain.length - 1];

  // 1. The chain ends in a root we pin — by bytes, not by name.
  if (!opts.rootsDer.some((r) => bytesEqual(r, root.der))) throw new JwsError("untrusted root certificate");
  // 2. Each certificate is signed by the next.
  for (let i = 0; i < chain.length - 1; i++) {
    if (!(await verifySignedBy(chain[i], chain[i + 1]))) throw new JwsError("broken certificate chain");
  }
  // 3. Apple's marks: a WWDR intermediate and a receipt-signing leaf.
  if (!intermediate.extensionOids.has(APPLE_OID_WWDR_INTERMEDIATE))
    throw new JwsError("intermediate is not a WWDR certificate");
  if (!leaf.extensionOids.has(APPLE_OID_RECEIPT_SIGNING)) throw new JwsError("leaf is not a receipt signer");

  // 4. The payload itself, under the leaf's key.
  const payload = decodeJsonSegment(payloadB64);
  const at = opts.nowMs ?? (typeof payload.signedDate === "number" ? payload.signedDate : Date.now());
  if (at < leaf.notBefore || at > leaf.notAfter) throw new JwsError("leaf certificate not valid at signing time");
  const key = await importSpki(leaf);
  const signature = base64UrlDecode(signatureB64);
  if (signature.length !== 64) throw new JwsError("bad JWS signature");
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signature,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!ok) throw new JwsError("JWS signature does not verify");
  return payload;
}

// Decodes a JWS payload WITHOUT verification. Only for logging what an
// unverifiable notification claimed to be — never for a decision.
export function peekJwsPayload(jws: string): Record<string, unknown> | null {
  try {
    return decodeJsonSegment(jws.split(".")[1] ?? "");
  } catch {
    return null;
  }
}
