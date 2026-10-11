import { describe, expect, it } from "vitest";
import { createVerify, generateKeyPairSync, verify } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ascToken, googleAssertion, signJwt } from "../../release/lib/jwt.mjs";
import { apiErrorDetail } from "../../release/lib/http.mjs";
import {
  checkNotes,
  gradleVersionName,
  marketingVersion,
  MAX_NOTES_CHARS,
  readNotes,
} from "../../release/lib/notes.mjs";
import {
  latestTestVersionCode,
  parseRollout,
  planRollout,
  planStart,
} from "../../release/lib/play.mjs";
import {
  pickBuild,
  planPhased,
  planPhasedChange,
  planReleaseRequest,
  planSubmission,
  planVersion,
} from "../../release/lib/app-store.mjs";

const ROOT = join(import.meta.dirname, "../..");
const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString());

describe("JWTs", () => {
  it("signs ES256 as raw r||s, verifiable against the public key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const token = ascToken({ issuerId: "iss-1", keyId: "KEY123", privateKeyPem: pem, nowMs: 1_700_000_000_000 });
    const [h, p, s] = token.split(".");
    expect(decode(h)).toEqual({ alg: "ES256", typ: "JWT", kid: "KEY123" });
    expect(decode(p)).toEqual({ iss: "iss-1", iat: 1_700_000_000, exp: 1_700_000_600, aud: "appstoreconnect-v1" });
    const sig = Buffer.from(s, "base64url");
    expect(sig.length).toBe(64);
    expect(verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  });

  it("keeps App Store Connect tokens under Apple's 20-minute ceiling", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const token = ascToken({ issuerId: "i", keyId: "k", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }), nowMs: 0 });
    const { iat, exp } = decode(token.split(".")[1]);
    expect(exp - iat).toBeLessThanOrEqual(20 * 60);
  });

  it("builds the Google service-account assertion with RS256", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const serviceAccount = {
      client_email: "ci@project.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      token_uri: "https://oauth2.googleapis.com/token",
    };
    const token = googleAssertion({ serviceAccount, nowMs: 1_000_000 });
    const [h, p, s] = token.split(".");
    expect(decode(h).alg).toBe("RS256");
    expect(decode(p)).toMatchObject({
      iss: serviceAccount.client_email,
      aud: serviceAccount.token_uri,
      scope: "https://www.googleapis.com/auth/androidpublisher",
    });
    const v = createVerify("sha256");
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("puts the header fields after alg and typ", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const t = signJwt({ alg: "ES256", header: { kid: "x" }, payload: {}, privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) });
    expect(Object.keys(decode(t.split(".")[0]))).toEqual(["alg", "typ", "kid"]);
  });
});

describe("store error messages", () => {
  it("reads App Store Connect's errors[]", () => {
    expect(
      apiErrorDetail({ errors: [{ title: "The request entity is not valid.", detail: "whatsNew is required" }] }, "")
    ).toBe("The request entity is not valid. — whatsNew is required");
  });
  it("reads Google's error.message", () => {
    expect(apiErrorDetail({ error: { code: 403, message: "The caller does not have permission" } }, "")).toBe(
      "The caller does not have permission"
    );
  });
  it("reads the OAuth token endpoint's error", () => {
    expect(apiErrorDetail({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, "")).toBe(
      "Invalid JWT Signature."
    );
  });
  it("falls back to the body text", () => {
    expect(apiErrorDetail(null, "Bad Gateway")).toBe("Bad Gateway");
  });
});

describe("release notes", () => {
  it("trims, and counts code points rather than UTF-16 units", () => {
    expect(checkNotes("  hello\r\n", "f")).toBe("hello");
    expect(() => checkNotes("🏁".repeat(MAX_NOTES_CHARS), "f")).not.toThrow();
    expect(() => checkNotes("a".repeat(MAX_NOTES_CHARS + 1), "f")).toThrow(/at most 500/);
  });
  it("refuses an empty file", () => {
    expect(() => checkNotes(" \n ", "release/notes/9.9.txt")).toThrow(/empty/);
  });
  it("names the missing file", () => {
    expect(() => readNotes(ROOT, "0.0-none")).toThrow("release/notes/0.0-none.txt does not exist");
  });
  it("every committed notes file is within both stores' limits", () => {
    for (const file of readdirSync(join(ROOT, "release/notes")).filter((f) => f.endsWith(".txt"))) {
      expect(() => readNotes(ROOT, file.replace(/\.txt$/, ""))).not.toThrow();
    }
  });
  it("reads the checked-in versions, which must agree so one notes file serves both stores", () => {
    const android = gradleVersionName(readFileSync(join(ROOT, "apps/android/app/build.gradle.kts"), "utf8"));
    const ios = marketingVersion(readFileSync(join(ROOT, "apps/ios/project.yml"), "utf8"));
    expect(android).toMatch(/^\d+(\.\d+)+$/);
    expect(ios).toBe(android);
    expect(gradleVersionName('versionName = "2.0"')).toBe("2.0");
    expect(marketingVersion('    MARKETING_VERSION: 3.1\n')).toBe("3.1");
  });
});

describe("Play production", () => {
  const notes = "Faster.";
  const tracks = (production = []) => [
    { track: "internal", releases: [{ versionCodes: ["410"], status: "completed" }] },
    { track: "alpha", releases: [{ versionCodes: ["399"], status: "completed" }, { versionCodes: ["999"], status: "draft" }] },
    { track: "production", releases: production },
  ];

  it("reads a rollout as a percentage, always", () => {
    expect(parseRollout("5")).toBe(0.05);
    expect(parseRollout("5%")).toBe(0.05);
    expect(parseRollout("0.5")).toBe(0.005);
    expect(parseRollout("1")).toBe(0.01);
    expect(parseRollout("100")).toBe(1);
    for (const bad of ["", "0", "-5", "101", "five", null]) expect(() => parseRollout(bad)).toThrow();
  });

  it("promotes the newest build testers received, never a draft", () => {
    expect(latestTestVersionCode(tracks())).toBe("410");
    expect(() => latestTestVersionCode([{ track: "internal", releases: [] }])).toThrow(/upload one first/);
  });

  it("compares version codes as numbers", () => {
    expect(
      latestTestVersionCode([{ track: "internal", releases: [{ versionCodes: ["99", "1000"], status: "completed" }] }])
    ).toBe("1000");
  });

  it("starts a staged rollout with notes in the listing's language", () => {
    const { source, update } = planStart({
      tracks: tracks([{ versionCodes: ["380"], status: "completed" }]),
      versionCode: 410,
      fraction: 0.05,
      notes,
      versionName: "1.17",
      language: "en-US",
    });
    expect(source).toBe("internal");
    expect(update).toEqual({
      track: "production",
      releases: [
        {
          name: "1.17 (410)",
          versionCodes: ["410"],
          status: "inProgress",
          userFraction: 0.05,
          releaseNotes: [{ language: "en-US", text: notes }],
        },
      ],
    });
  });

  it("a 100% start is a full release with no fraction", () => {
    const { update } = planStart({ tracks: tracks(), versionCode: "410", fraction: 1, notes, versionName: "1.17", language: "en-GB" });
    expect(update.releases[0].status).toBe("completed");
    expect(update.releases[0]).not.toHaveProperty("userFraction");
  });

  it("refuses a build that never reached a test track", () => {
    expect(() =>
      planStart({ tracks: tracks(), versionCode: "999", fraction: 0.05, notes, versionName: "1.17", language: "en-US" })
    ).toThrow(/not on a test track/);
  });

  it("refuses to start over a rollout in progress, but not over a halted one", () => {
    const args = { versionCode: "410", fraction: 0.05, notes, versionName: "1.17", language: "en-US" };
    expect(() =>
      planStart({ tracks: tracks([{ versionCodes: ["380"], status: "inProgress", userFraction: 0.2 }]), ...args })
    ).toThrow(/in progress \(380 at 20%\)/);
    expect(() =>
      planStart({ tracks: tracks([{ versionCodes: ["380"], status: "halted", userFraction: 0.2 }]), ...args })
    ).not.toThrow();
    expect(() =>
      planStart({ tracks: tracks([{ versionCodes: ["410"], status: "completed" }]), ...args })
    ).toThrow(/already on production/);
  });

  const staged = {
    name: "1.17 (410)",
    versionCodes: ["410"],
    status: "inProgress",
    userFraction: 0.05,
    releaseNotes: [{ language: "en-US", text: notes }],
  };
  const live = tracks([{ versionCodes: ["380"], status: "completed" }, staged]);

  it("grows a rollout and carries the release whole", () => {
    const { update } = planRollout({ tracks: live, action: "increase", fraction: 0.2 });
    expect(update.releases).toEqual([{ ...staged, userFraction: 0.2 }]);
  });

  it("never shrinks a rollout, and sends 100% to complete", () => {
    expect(() => planRollout({ tracks: live, action: "increase", fraction: 0.05 })).toThrow(/only grow/);
    expect(() => planRollout({ tracks: live, action: "increase", fraction: 1 })).toThrow(/complete action/);
  });

  it("halts, resumes and completes", () => {
    const halted = planRollout({ tracks: live, action: "halt" }).update.releases[0];
    expect(halted).toEqual({ ...staged, status: "halted" });
    const haltedTracks = tracks([halted]);
    expect(() => planRollout({ tracks: haltedTracks, action: "increase", fraction: 0.5 })).toThrow(/resume it/);
    expect(() => planRollout({ tracks: haltedTracks, action: "halt" })).toThrow(/already halted/);
    expect(planRollout({ tracks: haltedTracks, action: "resume" }).update.releases[0].status).toBe("inProgress");
    expect(() => planRollout({ tracks: live, action: "resume" })).toThrow(/not halted/);
    const done = planRollout({ tracks: live, action: "complete" }).update.releases[0];
    expect(done.status).toBe("completed");
    expect(done).not.toHaveProperty("userFraction");
    expect(done.releaseNotes).toEqual(staged.releaseNotes);
  });

  it("has nothing to move without a staged rollout", () => {
    expect(() => planRollout({ tracks: tracks([{ versionCodes: ["380"], status: "completed" }]), action: "complete" })).toThrow(
      /no staged rollout/
    );
  });
});

describe("App Store review", () => {
  const version = (versionString, appVersionState, id = versionString) => ({
    id,
    attributes: { versionString, appVersionState },
  });
  const build = (n, processingState = "VALID", extra = {}) => ({
    id: `b${n}`,
    attributes: { version: String(n), processingState, expired: false, usesNonExemptEncryption: false, ...extra },
  });

  it("creates a version when none is open", () => {
    expect(planVersion([version("1.16", "READY_FOR_DISTRIBUTION")], "1.17")).toEqual({ kind: "create" });
  });

  it("reuses an editable version, in either state vocabulary", () => {
    expect(planVersion([version("1.17", "PREPARE_FOR_SUBMISSION", "v1")], "1.17")).toEqual({
      kind: "reuse",
      id: "v1",
      state: "PREPARE_FOR_SUBMISSION",
    });
    const legacy = { id: "v2", attributes: { versionString: "1.17", appStoreState: "DEVELOPER_REJECTED" } };
    expect(planVersion([legacy], "1.17").kind).toBe("reuse");
  });

  it("says the train is closed once a version is approved", () => {
    for (const state of ["READY_FOR_SALE", "READY_FOR_DISTRIBUTION", "PENDING_DEVELOPER_RELEASE", "ACCEPTED"]) {
      expect(() => planVersion([version("1.17", state)], "1.17")).toThrow(/train is closed/);
    }
  });

  it("refuses a version already with review, or a second open version", () => {
    expect(() => planVersion([version("1.17", "WAITING_FOR_REVIEW")], "1.17")).toThrow(/already submitted/);
    expect(() => planVersion([version("1.18", "PREPARE_FOR_SUBMISSION")], "1.17")).toThrow(/1\.18 is already being prepared/);
  });

  it("takes the newest upload, and waits for it rather than an older processed one", () => {
    expect(pickBuild([build(12), build(11)]).build.id).toBe("b12");
    expect(pickBuild([build(12, "PROCESSING"), build(11)])).toMatchObject({ status: "processing" });
    expect(pickBuild([build(12), build(11)], "11").build.id).toBe("b11");
    expect(pickBuild([build(12)], "13")).toEqual({ status: "missing" });
    expect(pickBuild([])).toEqual({ status: "missing" });
  });

  it("refuses builds App Review can't take", () => {
    expect(() => pickBuild([build(12, "INVALID")])).toThrow(/INVALID/);
    expect(() => pickBuild([build(12, "VALID", { expired: true })])).toThrow(/expired/);
    expect(() => pickBuild([build(12, "VALID", { usesNonExemptEncryption: null })])).toThrow(/export-compliance/);
  });

  it("plans the phased release", () => {
    expect(planPhased(null, true)).toBe("create");
    expect(planPhased({ id: "p" }, false)).toBe("delete");
    expect(planPhased({ id: "p" }, true)).toBe("keep");
    expect(planPhased(null, false)).toBe("keep");
  });

  it("reuses a draft submission and refuses one App Review holds", () => {
    const sub = (state, id = state) => ({ id, attributes: { state } });
    expect(planSubmission([])).toEqual({ kind: "create" });
    expect(planSubmission([sub("READY_FOR_REVIEW", "d1")])).toEqual({ kind: "reuse", id: "d1" });
    expect(() => planSubmission([sub("IN_REVIEW")])).toThrow(/already with App Review/);
    expect(() => planSubmission([sub("WAITING_FOR_REVIEW")])).toThrow(/already with App Review/);
    expect(() => planSubmission([sub("UNRESOLVED_ISSUES")])).toThrow(/Resolution Center/);
    expect(() => planSubmission([sub("CANCELING")])).toThrow(/cancelled/);
  });

  it("moves a phased release only from a state that allows it", () => {
    const phased = (s) => ({ id: "p", attributes: { phasedReleaseState: s } });
    expect(planPhasedChange(phased("ACTIVE"), "pause-phased")).toBe("PAUSED");
    expect(planPhasedChange(phased("PAUSED"), "resume-phased")).toBe("ACTIVE");
    expect(planPhasedChange(phased("PAUSED"), "complete-phased")).toBe("COMPLETE");
    expect(() => planPhasedChange(phased("INACTIVE"), "pause-phased")).toThrow(/needs it ACTIVE/);
    expect(() => planPhasedChange(null, "pause-phased")).toThrow(/no phased release/);
  });

  it("releases only an approved, manually released version", () => {
    expect(planReleaseRequest(version("1.17", "PENDING_DEVELOPER_RELEASE", "v9"), "1.17")).toBe("v9");
    expect(() => planReleaseRequest(version("1.17", "IN_REVIEW"), "1.17")).toThrow(/only an approved/);
    expect(() => planReleaseRequest(null, "1.17")).toThrow(/no App Store version/);
  });
});
