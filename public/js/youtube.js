// Publish a best-lap video to YouTube (NS-46,
// docs/specs/native/NS-46-youtube-upload.md): the client's pure half — which
// control a lap's video panel offers, the status line under it, and every
// sentence the feature says. The upload itself runs on the server; a client is
// a form and a status line.
//
// The reference the iOS Kit and Android :core port as `YouTubeUpload` under
// the same names, pinned by contracts/logic/youtube.json. The draft's title and
// description are the server's (GET /api/clips/:id/youtube/draft), so no client
// builds them.

import { canSaveLapVideo } from "./entitlement.js";

export const YOUTUBE_PRIVACY = Object.freeze([
  Object.freeze({ value: "private", label: "Private" }),
  Object.freeze({ value: "unlisted", label: "Unlisted" }),
  Object.freeze({ value: "public", label: "Public" }),
]);
// Unlisted: the setting that matches sharing a link with a club or an
// instructor. Public is a choice the driver makes.
export const YOUTUBE_DEFAULT_PRIVACY = "unlisted";

// The consent explanation, above Connect on every client, word for word.
// "YouTube Terms of Service" and "Google Privacy Policy" are links
// (YOUTUBE_LINKS) — Google's API terms require both.
export const YOUTUBE_CONNECT_TEXT =
  "Track Evolution will ask Google for permission to upload videos to your YouTube channel. " +
  "It uploads only the videos you choose, and can't see, change or delete anything else on your channel. " +
  "Uses YouTube API Services: YouTube Terms of Service · Google Privacy Policy.";
export const YOUTUBE_LINKS = Object.freeze([
  Object.freeze({ label: "YouTube Terms of Service", url: "https://www.youtube.com/t/terms" }),
  Object.freeze({ label: "Google Privacy Policy", url: "https://policies.google.com/privacy" }),
]);
// Where a driver revokes the grant at Google's end.
export const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";

// Fixed on the sheet rather than asked: in-car track footage isn't directed at
// children, and the uploader is responsible for saying so.
export const YOUTUBE_KIDS_TEXT = "Not made for kids";
export const YOUTUBE_DELETE_NOTE = "The copy on YouTube stays. Delete it in YouTube Studio.";
export const YOUTUBE_DISCONNECT_NOTE = "Videos you've uploaded stay on YouTube.";
export const YOUTUBE_OFFLINE = "Uploading to YouTube needs a connection.";
export const YOUTUBE_RESULT_TEXT = Object.freeze({
  connected: "YouTube is connected.",
  denied: "YouTube wasn't connected — Google's permission was declined.",
  error: "Couldn't connect YouTube. Try again.",
});

// The control a lap's video panel offers:
//   none     — nothing: the feature is off for this account, there's no ready
//              clip, or it's a coach's read-only view (whatever the upload's
//              state — the link is the driver's to hand out)
//   locked   — nothing beyond NS-45's locked player (a free account)
//   connect  — Connect YouTube… (no live grant; a revoked one too)
//   upload   — Upload to YouTube…
//   pending  — the status line, polled
//   done     — On YouTube · <privacy>, and Open
//   failed   — the error, and Try again
//
// A lapsed owner keeps `done` (the link isn't Pro) and `pending` (a lapse
// doesn't stop an upload already queued); everything that starts one is Pro,
// through `canSaveLapVideo` — the same decision about the same clip as
// downloading it.
export function youtubeOffer(clip, entitlement, me, readOnly) {
  if (readOnly) return "none";
  if (!me?.youtube?.available) return "none";
  if (!clip) return "none";
  const status = clip.youtube?.status ?? null;
  if (status === "done") return "done";
  if (status === "queued" || status === "uploading") return "pending";
  if (!canSaveLapVideo(entitlement)) return "locked";
  if (!me.youtube.connected) return "connect";
  if (status === "failed") return "failed";
  return "upload";
}

export const youtubePrivacyLabel = (value) => YOUTUBE_PRIVACY.find((p) => p.value === value)?.label ?? "Private";

const GENERIC_FAILURE = "YouTube didn't accept the upload. Try again.";

// The line under the player, from GET /api/clips/:id/youtube (or the event
// detail's `clip.youtube`, which carries no progress). A queued or uploading
// row's `error` is a waiting note ("…uploads continue tomorrow") and wins. The
// percentage is floored and held under 100, so it never says 100% before
// YouTube has said done.
export function youtubeStatusLine(upload) {
  if (!upload) return "";
  switch (upload.status) {
    case "done":
      return `On YouTube · ${youtubePrivacyLabel(upload.privacy)}`;
    case "failed":
      return upload.error || GENERIC_FAILURE;
    case "queued":
      return upload.error || "Waiting to upload to YouTube";
    case "uploading": {
      if (upload.error) return upload.error;
      const pct = Math.min(99, Math.max(0, Math.floor((Number(upload.progress) || 0) * 100)));
      return `Uploading to YouTube · ${pct}%`;
    }
    default:
      return "";
  }
}

// Keep polling while this is true (every 5 s, while the page is visible).
export const youtubeIsPending = (upload) => upload?.status === "queued" || upload?.status === "uploading";

// The server's refusals of POST /api/clips/:id/youtube, said as the form says
// them. Anything else (a 400's named rule) is shown as the server worded it.
export function youtubeRequestError(message) {
  switch (message) {
    case "youtube upload limit":
      return "You can upload 10 videos to YouTube a day.";
    case "youtube not connected":
      return "Connect YouTube in Settings first.";
    case "already on youtube":
      return "This video is already on YouTube.";
    case "youtube upload in progress":
      return "This video is already uploading to YouTube.";
    case "clip not ready":
      return "This video is still uploading to Track Evolution.";
    case "pro required":
      return "Uploading to YouTube is part of Pro.";
    default:
      return message || GENERIC_FAILURE;
  }
}

// Settings' line for the connection on GET /api/me's `user.youtube`.
export function youtubeAccountLine(yt) {
  if (!yt?.available) return "";
  if (!yt.connected) return yt.account ? `YouTube access for ${yt.account} was removed. Reconnect to upload again.` : "Not connected.";
  const who = yt.account ? `Connected as ${yt.account}` : "Connected";
  return yt.channel_title ? `${who} · ${yt.channel_title}` : who;
}
