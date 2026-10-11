// Release notes: one file per marketing version, release/notes/<version>.txt,
// read by both store workflows. Both apps carry the same version (1.17 on iOS
// and Android alike), so one text serves both — held to Play's limit, the
// tighter of the two (Play 500 characters, the App Store's "What's New" 4000).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_NOTES_CHARS = 500;

// Characters as the stores count them: code points, not UTF-16 units.
export function checkNotes(text, file) {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed) throw new Error(`${file} is empty — write the release notes first.`);
  const length = [...trimmed].length;
  if (length > MAX_NOTES_CHARS) {
    throw new Error(
      `${file} is ${length} characters; Google Play takes at most ${MAX_NOTES_CHARS}.`
    );
  }
  return trimmed;
}

export function notesPath(root, version) {
  return join(root, "release", "notes", `${version}.txt`);
}

export function readNotes(root, version) {
  const file = notesPath(root, version);
  const shown = `release/notes/${version}.txt`;
  if (!existsSync(file)) {
    throw new Error(`${shown} does not exist — write the release notes for ${version} first.`);
  }
  return checkNotes(readFileSync(file, "utf8"), shown);
}

// The checked-in versions, used when a dispatch doesn't name one.

export function gradleVersionName(text) {
  const m =
    text.match(/versionName\s*=\s*env\("TE_VERSION_NAME"\)\s*\?:\s*"([^"]+)"/) ??
    text.match(/versionName\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("no versionName found in apps/android/app/build.gradle.kts");
  return m[1];
}

export function marketingVersion(text) {
  const m = text.match(/^\s*MARKETING_VERSION:\s*"?([0-9][0-9A-Za-z.]*)"?\s*$/m);
  if (!m) throw new Error("no MARKETING_VERSION found in apps/ios/project.yml");
  return m[1];
}
