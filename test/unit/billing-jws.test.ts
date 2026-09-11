import { describe, expect, it } from "vitest";
import { JwsError, parseCertificate, verifyX5cJws } from "../../src/lib/billing/jws";
import { APPLE_ROOTS_DER_B64 } from "../../src/lib/billing/apple-roots";
import { b64urlJson, pemToDer, signFixtureJws } from "../billing-helpers";
import { chain, leafNoExt, otherChain } from "../fixtures/billing/pems.mjs";

// Synthetic chains from test/fixtures/billing/build.sh — same shape as Apple's
// (root → WWDR-marked intermediate → receipt-signing leaf), different root.
const testRoots = () => ({ rootsDer: [pemToDer(chain.root)] });
// signedDate is after the fixtures' notBefore (they were minted in 2026) and
// well inside their 100-year validity.
const payload = { bundleId: "app.trackevolution", originalTransactionId: "1000", signedDate: 1_800_000_000_000 };

describe("parseCertificate", () => {
  it("parses the real Apple Root CA - G3", () => {
    const root = parseCertificate(Uint8Array.from(atob(APPLE_ROOTS_DER_B64[0]), (c) => c.charCodeAt(0)));
    expect(root.curve.name).toBe("P-384");
    expect(root.signatureHash).toBe("SHA-384");
    expect(new Date(root.notAfter).getUTCFullYear()).toBe(2039);
  });

  it("reads the Apple extension OIDs off the fixture chain", () => {
    expect(parseCertificate(pemToDer(chain.intermediate)).extensionOids.has("1.2.840.113635.100.6.2.1")).toBe(true);
    expect(parseCertificate(pemToDer(chain.leaf)).extensionOids.has("1.2.840.113635.100.6.11.1")).toBe(true);
    expect(parseCertificate(pemToDer(leafNoExt.leaf)).extensionOids.has("1.2.840.113635.100.6.11.1")).toBe(false);
  });
});

describe("verifyX5cJws", () => {
  it("accepts a JWS signed by a receipt-signing leaf chaining to a pinned root", async () => {
    const jws = await signFixtureJws(payload, chain);
    expect(await verifyX5cJws(jws, testRoots())).toEqual(payload);
  });

  it("rejects a chain to a different root, even a well-formed one", async () => {
    const jws = await signFixtureJws(payload, otherChain);
    await expect(verifyX5cJws(jws, testRoots())).rejects.toThrow(/untrusted root/);
    // …and the same JWS passes when that root is the one pinned.
    expect(await verifyX5cJws(jws, { rootsDer: [pemToDer(otherChain.root)] })).toEqual(payload);
  });

  it("rejects a leaf without the receipt-signing OID", async () => {
    const jws = await signFixtureJws(payload, chain, leafNoExt);
    await expect(verifyX5cJws(jws, testRoots())).rejects.toThrow(/receipt signer/);
  });

  it("rejects a tampered payload", async () => {
    const jws = await signFixtureJws(payload, chain);
    const [h, , s] = jws.split(".");
    const forged = b64urlJson({ ...payload, bundleId: "evil.app" });
    await expect(verifyX5cJws(`${h}.${forged}.${s}`, testRoots())).rejects.toThrow(/does not verify/);
  });

  it("rejects a leaf the intermediate did not sign", async () => {
    // Real intermediate + root, but the leaf (and key) from the other chain.
    const jws = await signFixtureJws(payload, chain, { leaf: otherChain.leaf, leafKey: otherChain.leafKey });
    await expect(verifyX5cJws(jws, testRoots())).rejects.toThrow(/broken certificate chain/);
  });

  it("rejects a leaf outside its validity at the signing time", async () => {
    const jws = await signFixtureJws(payload, chain);
    await expect(verifyX5cJws(jws, { ...testRoots(), nowMs: Date.UTC(1999, 0, 1) })).rejects.toThrow(/not valid/);
  });

  it("rejects non-ES256, a missing chain, and garbage", async () => {
    await expect(verifyX5cJws(await signFixtureJws(payload, chain, { alg: "RS256" }), testRoots())).rejects.toThrow(JwsError);
    await expect(verifyX5cJws("a.b", testRoots())).rejects.toThrow(JwsError);
    await expect(verifyX5cJws("not.a.jws", testRoots())).rejects.toThrow(JwsError);
    const noChain = `${b64urlJson({ alg: "ES256" })}.${b64urlJson({})}.AAAA`;
    await expect(verifyX5cJws(noChain, testRoots())).rejects.toThrow(/no certificate chain/);
  });
});
