// The decisions behind the Play production workflow, kept free of I/O so the
// rules are tested rather than discovered in a store review. Shapes are the
// Android Publisher API's: a track is { track, releases: [{ name,
// versionCodes: ["123"], status, userFraction?, releaseNotes? }] }, with
// version codes as strings (they are int64s).
//
// The rule underneath all of it: production only ever receives a bundle that
// is already on a test track. Promotion never rebuilds, so what reaches review
// is byte for byte what testers ran.

export const TEST_TRACKS = ["internal", "alpha", "beta"];
export const PRODUCTION = "production";
export const ACTIONS = ["status", "start", "increase", "halt", "resume", "complete"];

// A percentage — "5", "5%", "0.5" (half a percent) — to Play's userFraction.
// Always read as a percent: "1" meaning 100% would be one typo from a full
// rollout.
export function parseRollout(input) {
  const raw = String(input ?? "").trim().replace(/%$/, "");
  const pct = Number(raw);
  if (!raw || !Number.isFinite(pct) || pct <= 0 || pct > 100) {
    throw new Error(`rollout must be a percentage above 0 and at most 100, not "${input}".`);
  }
  // Play stores a double; four decimals is a hundredth of a percent.
  return Math.round(pct * 100) / 10000;
}

const pctText = (fraction) => `${+(fraction * 100).toFixed(2)}%`;

const trackOf = (tracks, name) => tracks.find((t) => t.track === name);
const codesOf = (release) => (release.versionCodes ?? []).map(String);

// A release testers actually received: not a draft nobody was offered, and
// not a halted one somebody pulled.
const served = (release) => release.status === "completed" || release.status === "inProgress";

export function findTestRelease(tracks, versionCode) {
  const code = String(versionCode);
  for (const name of TEST_TRACKS) {
    for (const release of trackOf(tracks, name)?.releases ?? []) {
      if (served(release) && codesOf(release).includes(code)) return { track: name, release };
    }
  }
  return null;
}

export function latestTestVersionCode(tracks) {
  let best = null;
  for (const name of TEST_TRACKS) {
    for (const release of trackOf(tracks, name)?.releases ?? []) {
      if (!served(release)) continue;
      for (const code of codesOf(release)) {
        if (best === null || BigInt(code) > BigInt(best)) best = code;
      }
    }
  }
  if (best === null) {
    throw new Error("No test track has a release to promote — upload one first (Play Store test track workflow).");
  }
  return best;
}

// The release to put on production. `fraction` 1 is a full release; anything
// below it is a staged rollout.
export function planStart({ tracks, versionCode, fraction, notes, versionName, language }) {
  const code = String(versionCode);
  const production = trackOf(tracks, PRODUCTION)?.releases ?? [];
  if (production.some((r) => codesOf(r).includes(code))) {
    throw new Error(`versionCode ${code} is already on production.`);
  }
  const staged = production.find((r) => r.status === "inProgress");
  if (staged) {
    throw new Error(
      `Production already has a staged rollout in progress (${codesOf(staged).join(", ")} at ${pctText(staged.userFraction ?? 0)}). Complete or halt it first.`
    );
  }
  const source = findTestRelease(tracks, code);
  if (!source) {
    throw new Error(
      `versionCode ${code} is not on a test track (${TEST_TRACKS.join(", ")}). Production only takes a build testers have run.`
    );
  }
  const release = {
    name: `${versionName} (${code})`,
    versionCodes: [code],
    status: fraction < 1 ? "inProgress" : "completed",
    releaseNotes: [{ language, text: notes }],
  };
  if (fraction < 1) release.userFraction = fraction;
  return { source: source.track, update: { track: PRODUCTION, releases: [release] } };
}

// Moving the staged rollout already on production. The update names only the
// staged release: Play keeps the completed release that is serving everyone
// else, which is how its own staged-rollout examples are written. The staged
// release is carried whole (name, notes, targeting) so nothing about it is
// lost by the round trip.
export function planRollout({ tracks, action, fraction }) {
  const production = trackOf(tracks, PRODUCTION)?.releases ?? [];
  const staged = production.find((r) => r.status === "inProgress" || r.status === "halted");
  if (!staged) throw new Error("Production has no staged rollout to change.");
  const current = staged.userFraction ?? 0;
  let next;
  switch (action) {
    case "increase":
      if (staged.status === "halted") throw new Error("The rollout is halted — resume it before increasing it.");
      if (fraction >= 1) throw new Error("To release to everyone, use the complete action.");
      if (fraction <= current) {
        throw new Error(`The rollout is already at ${pctText(current)}; a staged rollout can only grow.`);
      }
      next = { ...staged, userFraction: fraction };
      break;
    case "halt":
      if (staged.status === "halted") throw new Error("The rollout is already halted.");
      next = { ...staged, status: "halted" };
      break;
    case "resume":
      if (staged.status !== "halted") throw new Error("The rollout is not halted.");
      next = { ...staged, status: "inProgress" };
      break;
    case "complete": {
      const { userFraction: _dropped, ...rest } = staged;
      next = { ...rest, status: "completed" };
      break;
    }
    default:
      throw new Error(`unknown action "${action}"`);
  }
  return { update: { track: PRODUCTION, releases: [next] }, from: staged };
}

export function describeRelease(release) {
  const parts = [`${release.name ?? "(unnamed)"} — ${codesOf(release).join(", ")} — ${release.status}`];
  if (release.userFraction != null) parts.push(`at ${pctText(release.userFraction)}`);
  return parts.join(" ");
}

export function describeTracks(tracks) {
  const lines = [];
  for (const name of [PRODUCTION, ...TEST_TRACKS]) {
    const releases = trackOf(tracks, name)?.releases ?? [];
    lines.push(`- **${name}**: ${releases.length ? releases.map(describeRelease).join("; ") : "nothing"}`);
  }
  return lines;
}

export { pctText };
