// The decisions behind the App Store review workflow, free of I/O. Shapes are
// App Store Connect API resources ({ id, type, attributes }).
//
// The rule underneath it matches the Play side: submit a build that is already
// on TestFlight. Xcode Cloud archives and uploads; this only chooses one of
// those builds and puts it in front of App Review.

export const ACTIONS = ["status", "submit", "release", "pause-phased", "resume-phased", "complete-phased"];
export const RELEASE_TYPES = ["MANUAL", "AFTER_APPROVAL"];

// App Store Connect reports a version's state in two vocabularies: the older
// `appStoreState` and its replacement `appVersionState`. Both are listed so a
// response carrying either reads the same.
export const EDITABLE_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
]);
export const IN_REVIEW_STATES = new Set([
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "WAITING_FOR_EXPORT_COMPLIANCE",
]);
export const PENDING_RELEASE_STATE = "PENDING_DEVELOPER_RELEASE";

export function versionState(version) {
  return version.attributes.appVersionState ?? version.attributes.appStoreState;
}

// Which App Store version the submission lands on: the one for this marketing
// version if it is still editable, or a new one. Refuses rather than guesses
// whenever App Store Connect would refuse anyway, so the message is ours.
export function planVersion(versions, versionString) {
  const match = versions.find((v) => v.attributes.versionString === versionString);
  if (!match) {
    const other = versions.find((v) => EDITABLE_STATES.has(versionState(v)));
    if (other) {
      throw new Error(
        `App Store version ${other.attributes.versionString} is already being prepared (${versionState(other)}); App Store Connect allows one at a time. Submit that version, or delete it in App Store Connect.`
      );
    }
    return { kind: "create" };
  }
  const state = versionState(match);
  if (EDITABLE_STATES.has(state)) return { kind: "reuse", id: match.id, state };
  if (IN_REVIEW_STATES.has(state)) {
    throw new Error(`Version ${versionString} is already submitted (${state}).`);
  }
  throw new Error(
    `Version ${versionString} is ${state}, so its train is closed. Bump MARKETING_VERSION in apps/ios/project.yml (and versionName on Android) for the next release.`
  );
}

// The build to submit, from the builds of this marketing version newest
// first. Without a number it is the newest upload — not the newest *processed*
// one, which would quietly submit an older build while the latest is still
// processing.
export function pickBuild(builds, buildNumber) {
  const build = buildNumber
    ? builds.find((b) => b.attributes.version === String(buildNumber))
    : builds[0];
  if (!build) return { status: "missing" };
  const { processingState, expired } = build.attributes;
  if (expired) throw new Error(`Build ${build.attributes.version} has expired on TestFlight.`);
  if (processingState === "PROCESSING") return { status: "processing", build };
  if (processingState !== "VALID") {
    throw new Error(`Build ${build.attributes.version} is ${processingState} and can't be submitted.`);
  }
  // Info.plist declares ITSAppUsesNonExemptEncryption = false, which answers
  // export compliance at upload. A build without the answer would stall in
  // WAITING_FOR_EXPORT_COMPLIANCE, and answering it is a legal declaration,
  // so this stops rather than answering on anyone's behalf.
  if (build.attributes.usesNonExemptEncryption == null) {
    throw new Error(
      `Build ${build.attributes.version} has no export-compliance answer. Answer it in App Store Connect, and check ITSAppUsesNonExemptEncryption is still in apps/ios/App/Info.plist.`
    );
  }
  return { status: "ready", build };
}

export function planPhased(existing, want) {
  if (want && !existing) return "create";
  if (!want && existing) return "delete";
  return "keep";
}

// An open review submission: reuse a draft, refuse anything App Review holds.
export function planSubmission(submissions) {
  const states = submissions.map((s) => s.attributes.state);
  const busy = submissions.find((s) =>
    ["WAITING_FOR_REVIEW", "IN_REVIEW"].includes(s.attributes.state)
  );
  if (busy) throw new Error(`A submission is already with App Review (${busy.attributes.state}).`);
  if (states.includes("UNRESOLVED_ISSUES")) {
    throw new Error(
      "The last submission came back with unresolved issues. Reply in App Store Connect's Resolution Center and resubmit from there — this workflow doesn't answer App Review."
    );
  }
  if (states.includes("CANCELING")) throw new Error("A submission is being cancelled; try again in a few minutes.");
  const draft = submissions.find((s) => s.attributes.state === "READY_FOR_REVIEW");
  return draft ? { kind: "reuse", id: draft.id } : { kind: "create" };
}

const PHASED_MOVES = {
  "pause-phased": { from: ["ACTIVE"], to: "PAUSED" },
  "resume-phased": { from: ["PAUSED"], to: "ACTIVE" },
  "complete-phased": { from: ["ACTIVE", "PAUSED"], to: "COMPLETE" },
};

export function planPhasedChange(phased, action) {
  const move = PHASED_MOVES[action];
  if (!move) throw new Error(`unknown action "${action}"`);
  if (!phased) throw new Error("This version has no phased release.");
  const state = phased.attributes.phasedReleaseState;
  if (!move.from.includes(state)) {
    throw new Error(`The phased release is ${state}; ${action} needs it ${move.from.join(" or ")}.`);
  }
  return move.to;
}

export function planReleaseRequest(version, versionString) {
  if (!version) throw new Error(`There is no App Store version ${versionString}.`);
  const state = versionState(version);
  if (state !== PENDING_RELEASE_STATE) {
    throw new Error(`Version ${versionString} is ${state}; only an approved, manually released version (${PENDING_RELEASE_STATE}) can be released.`);
  }
  return version.id;
}
