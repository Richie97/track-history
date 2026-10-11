#!/usr/bin/env node
// Promote a tested build to Google Play production, or move its staged
// rollout. Run by .github/workflows/play-production.yml; README → "Store
// submission" has the rules and the secrets.
//
// Environment:
//   PLAY_SERVICE_ACCOUNT_JSON  the service-account key (same secret the test-track upload uses)
//   ACTION        status | start | increase | halt | resume | complete
//   VERSION_CODE  start only: the build to promote (default: the newest on a test track)
//   ROLLOUT       start / increase: a percentage (start defaults to 5)
//   VERSION       start only: release notes version (default: versionName in build.gradle.kts)
//   DRY_RUN       "true": validate the edit with Play, then discard it
//
// Everything happens inside one Play *edit*, which is a transaction: nothing
// is visible until the commit, and a validated-but-uncommitted edit is how a
// dry run asks Play itself whether the change would be accepted.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { googleAssertion } from "./lib/jwt.mjs";
import { requestJson } from "./lib/http.mjs";
import { gradleVersionName, readNotes } from "./lib/notes.mjs";
import {
  ACTIONS,
  describeRelease,
  describeTracks,
  latestTestVersionCode,
  parseRollout,
  pctText,
  planRollout,
  planStart,
} from "./lib/play.mjs";
import { input, required, summary } from "./lib/summary.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "app.trackevolution";
const BASE = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;

async function accessToken(serviceAccount) {
  const { access_token } = await requestJson(serviceAccount.token_uri, {
    method: "POST",
    form: {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: googleAssertion({ serviceAccount, nowMs: Date.now() }),
    },
  });
  return access_token;
}

async function main(out) {
  const action = input("ACTION") ?? "status";
  if (!ACTIONS.includes(action)) throw new Error(`ACTION must be one of ${ACTIONS.join(", ")}.`);
  const dryRun = input("DRY_RUN") === "true";
  const serviceAccount = JSON.parse(
    required("PLAY_SERVICE_ACCOUNT_JSON", "Add the repository secret (README → Play Store test track).")
  );

  const token = await accessToken(serviceAccount);
  const api = (method, path, body) =>
    requestJson(BASE + path, { method, headers: { authorization: `Bearer ${token}` }, body });

  const edit = await api("POST", "/edits", {});
  let committed = false;
  try {
    const { tracks = [] } = await api("GET", `/edits/${edit.id}/tracks`);
    out.line("Tracks before this run:");
    out.lines(describeTracks(tracks));
    out.line();
    if (action === "status") return;

    let update;
    if (action === "start") {
      const versionCode = input("VERSION_CODE") ?? latestTestVersionCode(tracks);
      const fraction = parseRollout(input("ROLLOUT") ?? "5");
      const versionName =
        input("VERSION") ??
        gradleVersionName(readFileSync(join(ROOT, "apps/android/app/build.gradle.kts"), "utf8"));
      const notes = readNotes(ROOT, versionName);
      // Notes go in the listing's default language — the one Play requires.
      const { defaultLanguage } = await api("GET", `/edits/${edit.id}/details`);
      const plan = planStart({ tracks, versionCode, fraction, notes, versionName, language: defaultLanguage });
      update = plan.update;
      out.line(
        `Promoting **${versionCode}** from \`${plan.source}\` to production at **${pctText(fraction)}**, notes from \`release/notes/${versionName}.txt\` (${defaultLanguage}):`
      );
      out.line();
      out.lines(notes.split("\n").map((l) => `> ${l}`));
    } else {
      const fraction = action === "increase" ? parseRollout(required("ROLLOUT", "Say what percentage to increase to.")) : undefined;
      const plan = planRollout({ tracks, action, fraction });
      update = plan.update;
      out.line(`${action}: ${describeRelease(plan.from)} → ${describeRelease(update.releases[0])}`);
    }
    out.line();

    await api("PUT", `/edits/${edit.id}/tracks/production`, update);
    if (dryRun) {
      await api("POST", `/edits/${edit.id}:validate`);
      out.line("**Dry run:** Play validated the change; it was discarded, not committed.");
      return;
    }
    try {
      await api("POST", `/edits/${edit.id}:commit`);
    } catch (err) {
      if (String(err.message).includes("changesNotSentForReview")) {
        throw new Error(
          `${err.message}\nPlay won't send this for review automatically — usually because an earlier update was rejected, or changes are already waiting in the Console's Publishing overview. Resolve those in the Play Console, then re-run.`
        );
      }
      throw err;
    }
    committed = true;
    out.line(
      action === "start"
        ? "Committed. The release goes to Google's review; with Managed publishing on, it then waits for *Publish* in the Console."
        : "Committed."
    );
  } finally {
    if (!committed) await api("DELETE", `/edits/${edit.id}`).catch(() => {});
  }
}

const out = summary("Play production");
try {
  await main(out);
} catch (err) {
  out.line(`**Failed:** ${err.message}`);
  console.log(`::error::${err.message.split("\n")[0]}`);
  process.exitCode = 1;
} finally {
  out.flush();
}
