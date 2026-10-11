#!/usr/bin/env node
// Submit a TestFlight build to App Review, release an approved version, or
// steer its phased release. Run by .github/workflows/app-store-review.yml;
// README → "Store submission" has the rules and the secrets.
//
// Environment:
//   APP_STORE_CONNECT_ISSUER_ID / _KEY_ID / _PRIVATE_KEY   the API key (.p8 contents)
//   ACTION        status | submit | release | pause-phased | resume-phased | complete-phased
//   VERSION       the marketing version (default: MARKETING_VERSION in apps/ios/project.yml)
//   BUILD_NUMBER  submit only: the Xcode Cloud build number (default: the newest upload)
//   RELEASE_TYPE  submit only: MANUAL (default) or AFTER_APPROVAL
//   PHASED        submit only: "false" turns off the 7-day phased release (default on)
//   WAIT_MINUTES  submit only: how long to wait for the build to finish processing (default 30)
//   DRY_RUN       "true": report what would happen and change nothing
//
// App Store Connect has no transaction like Play's edit, so a submit is a
// sequence of writes — version, build, notes, phased release, submission —
// each of which is safe to repeat: re-running after a failure picks up the
// same version and draft submission rather than making new ones.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { ascToken } from "./lib/jwt.mjs";
import { requestJson, StoreApiError } from "./lib/http.mjs";
import { marketingVersion, readNotes } from "./lib/notes.mjs";
import {
  ACTIONS,
  RELEASE_TYPES,
  pickBuild,
  planPhased,
  planPhasedChange,
  planReleaseRequest,
  planSubmission,
  planVersion,
  versionState,
} from "./lib/app-store.mjs";
import { input, required, summary } from "./lib/summary.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_ID = "app.trackevolution";
const BASE = "https://api.appstoreconnect.apple.com";
const POLL_MS = 30_000;
const OPEN_SUBMISSION_STATES = "READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES,CANCELING";

function client() {
  const hint = "Add the App Store Connect API key secrets (README → Store submission).";
  const issuerId = required("APP_STORE_CONNECT_ISSUER_ID", hint);
  const keyId = required("APP_STORE_CONNECT_KEY_ID", hint);
  const privateKeyPem = required("APP_STORE_CONNECT_PRIVATE_KEY", hint);
  return (method, path, body) =>
    requestJson(BASE + path, {
      method,
      headers: { authorization: `Bearer ${ascToken({ issuerId, keyId, privateKeyPem, nowMs: Date.now() })}` },
      body,
    });
}

const ref = (type, id) => ({ data: { type, id } });

async function findApp(api) {
  const { data } = await api("GET", `/v1/apps?filter[bundleId]=${BUNDLE_ID}`);
  const app = data.find((a) => a.attributes.bundleId === BUNDLE_ID);
  if (!app) throw new Error(`No app with bundle id ${BUNDLE_ID} is visible to this API key.`);
  return app;
}

async function listVersions(api, appId) {
  const { data } = await api("GET", `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=200`);
  return data.sort((a, b) => String(b.attributes.createdDate).localeCompare(String(a.attributes.createdDate)));
}

async function listBuilds(api, appId, version) {
  const { data } = await api(
    "GET",
    `/v1/builds?filter[app]=${appId}&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&sort=-uploadedDate&limit=50`
  );
  return data;
}

async function phasedRelease(api, versionId) {
  try {
    const { data } = await api("GET", `/v1/appStoreVersions/${versionId}/appStoreVersionPhasedRelease`);
    return data ?? null;
  } catch (err) {
    if (err instanceof StoreApiError && err.status === 404) return null;
    throw err;
  }
}

// Xcode Cloud's upload lands minutes before Apple has processed it; a named
// build that is still processing, or not visible yet, is waited for.
async function waitForBuild(api, appId, version, buildNumber, waitMinutes, out) {
  const deadline = Date.now() + waitMinutes * 60_000;
  let announced = false;
  for (;;) {
    const picked = pickBuild(await listBuilds(api, appId, version), buildNumber);
    if (picked.status === "ready") return picked.build;
    if (picked.status === "missing" && !buildNumber) {
      throw new Error(`No build of ${version} has been uploaded. Is MARKETING_VERSION right, and has Xcode Cloud archived it?`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        picked.status === "missing"
          ? `Build ${buildNumber} of ${version} did not appear within ${waitMinutes} minutes.`
          : `Build ${picked.build.attributes.version} is still processing${waitMinutes ? ` after ${waitMinutes} minutes` : ""}; re-run once it finishes.`
      );
    }
    if (!announced) {
      out.line(
        picked.status === "missing"
          ? `Waiting for build ${buildNumber} of ${version} to appear…`
          : `Waiting for build ${picked.build.attributes.version} to finish processing…`
      );
      announced = true;
    }
    await sleep(POLL_MS);
  }
}

async function status(api, app, version, out) {
  const versions = await listVersions(api, app.id);
  out.line("App Store versions (newest first):");
  for (const v of versions.slice(0, 5)) {
    const phased = await phasedRelease(api, v.id);
    out.line(
      `- **${v.attributes.versionString}** — ${versionState(v)} — ${v.attributes.releaseType ?? "?"}${phased ? ` — phased release ${phased.attributes.phasedReleaseState}` : ""}`
    );
  }
  const { data: subs } = await api(
    "GET",
    `/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=${OPEN_SUBMISSION_STATES}`
  );
  out.line();
  out.line(`Open review submissions: ${subs.length ? subs.map((s) => s.attributes.state).join(", ") : "none"}`);
  const builds = await listBuilds(api, app.id, version);
  out.line();
  out.line(`Builds of ${version} (newest first):`);
  out.lines(
    builds.length
      ? builds.slice(0, 5).map((b) => `- **${b.attributes.version}** — ${b.attributes.processingState}${b.attributes.expired ? " (expired)" : ""} — uploaded ${b.attributes.uploadedDate}`)
      : ["- none"]
  );
}

async function submit(api, app, version, out) {
  const buildNumber = input("BUILD_NUMBER");
  const releaseType = input("RELEASE_TYPE") ?? "MANUAL";
  if (!RELEASE_TYPES.includes(releaseType)) throw new Error(`RELEASE_TYPE must be ${RELEASE_TYPES.join(" or ")}.`);
  const phased = input("PHASED") !== "false";
  const waitMinutes = Number(input("WAIT_MINUTES") ?? "30");
  const dryRun = input("DRY_RUN") === "true";

  // Everything that can refuse is checked before the first write.
  const notes = readNotes(ROOT, version);
  const build = await waitForBuild(api, app.id, version, buildNumber, dryRun ? 0 : waitMinutes, out);
  const versionPlan = planVersion(await listVersions(api, app.id), version);
  const { data: subs } = await api(
    "GET",
    `/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=${OPEN_SUBMISSION_STATES}`
  );
  const submissionPlan = planSubmission(subs);
  const existingPhased = versionPlan.kind === "reuse" ? await phasedRelease(api, versionPlan.id) : null;
  const phasedPlan = planPhased(existingPhased, phased);

  out.line(`Submitting **${version} (${build.attributes.version})** for review:`);
  out.line(`- App Store version: ${versionPlan.kind === "create" ? "create it" : `reuse it (${versionPlan.state})`}`);
  out.line(`- release: ${releaseType === "MANUAL" ? "manually, once approved (the *release* action)" : "automatically once approved"}`);
  out.line(`- phased release: ${phased ? "on — 7 days" : "off — everyone at once"}${phasedPlan === "keep" ? "" : ` (${phasedPlan})`}`);
  out.line(`- review submission: ${submissionPlan.kind === "create" ? "create one" : "add to the open draft"}`);
  out.line(`- What's New, from \`release/notes/${version}.txt\`:`);
  out.line();
  out.lines(notes.split("\n").map((l) => `> ${l}`));
  out.line();
  if (dryRun) {
    out.line("**Dry run:** nothing was changed.");
    return;
  }

  let versionId;
  if (versionPlan.kind === "create") {
    const { data } = await api("POST", "/v1/appStoreVersions", {
      data: {
        type: "appStoreVersions",
        attributes: { platform: "IOS", versionString: version, releaseType },
        relationships: { app: ref("apps", app.id) },
      },
    });
    versionId = data.id;
  } else {
    versionId = versionPlan.id;
    await api("PATCH", `/v1/appStoreVersions/${versionId}`, {
      data: { type: "appStoreVersions", id: versionId, attributes: { releaseType } },
    });
  }
  await api("PATCH", `/v1/appStoreVersions/${versionId}/relationships/build`, { data: { type: "builds", id: build.id } });

  // A new version copies its localizations from the last one, and App Review
  // requires What's New in every one of them, so the notes go in each.
  const { data: localizations } = await api("GET", `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`);
  if (!localizations.length) throw new Error(`Version ${version} has no localizations to write What's New into.`);
  for (const loc of localizations) {
    await api("PATCH", `/v1/appStoreVersionLocalizations/${loc.id}`, {
      data: { type: "appStoreVersionLocalizations", id: loc.id, attributes: { whatsNew: notes } },
    });
  }
  out.line(`What's New written to ${localizations.map((l) => l.attributes.locale).join(", ")}.`);

  if (phasedPlan === "create") {
    await api("POST", "/v1/appStoreVersionPhasedReleases", {
      data: {
        type: "appStoreVersionPhasedReleases",
        attributes: { phasedReleaseState: "INACTIVE" },
        relationships: { appStoreVersion: ref("appStoreVersions", versionId) },
      },
    });
  } else if (phasedPlan === "delete") {
    await api("DELETE", `/v1/appStoreVersionPhasedReleases/${existingPhased.id}`);
  }

  let submissionId = submissionPlan.id;
  if (submissionPlan.kind === "create") {
    const { data } = await api("POST", "/v1/reviewSubmissions", {
      data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: ref("apps", app.id) } },
    });
    submissionId = data.id;
  }
  const { data: items } = await api("GET", `/v1/reviewSubmissions/${submissionId}/items?include=appStoreVersion`);
  if (!items.some((i) => i.relationships?.appStoreVersion?.data?.id === versionId)) {
    await api("POST", "/v1/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: ref("reviewSubmissions", submissionId),
          appStoreVersion: ref("appStoreVersions", versionId),
        },
      },
    });
  }
  await api("PATCH", `/v1/reviewSubmissions/${submissionId}`, {
    data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } },
  });
  out.line("**Submitted to App Review.**");
}

async function versionNamed(api, app, version) {
  return (await listVersions(api, app.id)).find((v) => v.attributes.versionString === version) ?? null;
}

async function release(api, app, version, out) {
  const versionId = planReleaseRequest(await versionNamed(api, app, version), version);
  if (input("DRY_RUN") === "true") {
    out.line(`**Dry run:** would release ${version}.`);
    return;
  }
  await api("POST", "/v1/appStoreVersionReleaseRequests", {
    data: { type: "appStoreVersionReleaseRequests", relationships: { appStoreVersion: ref("appStoreVersions", versionId) } },
  });
  const phased = await phasedRelease(api, versionId);
  out.line(`**Released ${version}**${phased ? " — the phased release starts now" : ""}.`);
}

async function movePhased(api, app, version, action, out) {
  const v = await versionNamed(api, app, version);
  if (!v) throw new Error(`There is no App Store version ${version}.`);
  const phased = await phasedRelease(api, v.id);
  const to = planPhasedChange(phased, action);
  if (input("DRY_RUN") === "true") {
    out.line(`**Dry run:** would set ${version}'s phased release to ${to}.`);
    return;
  }
  await api("PATCH", `/v1/appStoreVersionPhasedReleases/${phased.id}`, {
    data: { type: "appStoreVersionPhasedReleases", id: phased.id, attributes: { phasedReleaseState: to } },
  });
  out.line(`${version}'s phased release is now **${to}**.`);
}

async function main(out) {
  const action = input("ACTION") ?? "status";
  if (!ACTIONS.includes(action)) throw new Error(`ACTION must be one of ${ACTIONS.join(", ")}.`);
  const version = input("VERSION") ?? marketingVersion(readFileSync(join(ROOT, "apps/ios/project.yml"), "utf8"));
  const api = client();
  const app = await findApp(api);
  if (action === "status") await status(api, app, version, out);
  else if (action === "submit") await submit(api, app, version, out);
  else if (action === "release") await release(api, app, version, out);
  else await movePhased(api, app, version, action, out);
}

const out = summary("App Store review");
try {
  await main(out);
} catch (err) {
  out.line(`**Failed:** ${err.message}`);
  console.log(`::error::${err.message.split("\n")[0]}`);
  process.exitCode = 1;
} finally {
  out.flush();
}
