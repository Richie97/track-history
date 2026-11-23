// The "this video is loading" mark over a <video> — the lap player's and the
// lap stage's. A lap video is the camera's own file streamed at the camera's
// bitrate, so the first frame, a seek and a slow connection each leave a black
// or frozen picture for a while; without a mark that reads as broken.
//
// Pure half first (`waitingAfter`, tested in test/unit/video-wait.test.js),
// then the DOM half that hangs it on an element.

// A wait shorter than this draws nothing: a seek inside what is already
// buffered, or the stage's follower being nudged back into step, would
// otherwise flash the mark on every one.
export const WAIT_SHOW_MS = 300;

// What a media event says about whether the video is waiting on the network:
// true (it is), false (it isn't), or null (this event doesn't say).
//
// `media` is the element's `{ readyState, seeking }` when the event fired.
//
// The one subtle row is `suspend`: with preload="metadata" a browser stops
// fetching once it has the metadata and never fires `canplay` (Safari doesn't
// fire `loadeddata` either), so `suspend` with metadata in hand is the only
// sign that the first load is over. Mid-seek it means nothing.
export function waitingAfter(type, media = {}) {
  switch (type) {
    case "loadstart":
    case "waiting":
    case "seeking":
      return true;
    case "loadeddata":
    case "canplay":
    case "playing":
    case "seeked":
    case "error":
    case "emptied":
      return false;
    case "suspend":
      return (media.readyState ?? 0) >= 1 && !media.seeking ? false : null;
    default:
      return null;
  }
}

const EVENTS = ["loadstart", "waiting", "seeking", "loadeddata", "canplay", "playing", "seeked", "error", "emptied", "suspend"];

// The mark's markup: a ring, and the words for a screen reader (and for
// anyone who has asked for less motion, where the ring stands still). `shown`
// draws it from the start — before the element has a `src`, while the signed
// URL is still on its way.
export const videoWaitHtml = (shown = false) =>
  `<span class="video-wait"${shown ? "" : " hidden"}><span class="video-wait-ring" aria-hidden="true"></span><span class="video-wait-text">Loading video…</span></span>`;

// Show `mark` while `video` waits. The first load shows at once — it is the
// long one, and the mark is usually already up from the URL fetch — and every
// later wait only after WAIT_SHOW_MS. Listeners live on the element, so they
// go when it does.
export function bindVideoWait(video, mark) {
  if (!video || !mark) return;
  let timer = null;
  const set = (on) => {
    mark.hidden = !on;
    if (on) video.setAttribute("aria-busy", "true");
    else video.removeAttribute("aria-busy");
  };
  const handle = (ev) => {
    const next = waitingAfter(ev.type, video);
    if (next == null) return;
    if (!next) {
      clearTimeout(timer);
      timer = null;
      set(false);
    } else if (ev.type === "loadstart") {
      clearTimeout(timer);
      timer = null;
      set(true);
    } else if (mark.hidden && timer == null) {
      timer = setTimeout(() => {
        timer = null;
        if (video.isConnected) set(true);
      }, WAIT_SHOW_MS);
    }
  };
  for (const type of EVENTS) video.addEventListener(type, handle);
}

// A video URL that opens at `seconds` — a media fragment (`#t=`), which every
// browser reads before it fetches a frame. Setting `currentTime` once the
// metadata is in does the same thing a request later: the browser has by then
// started on the clip's first seconds, which are thrown away.
export function srcAt(url, seconds) {
  const t = Number(seconds);
  if (!Number.isFinite(t) || t <= 0) return url;
  return `${String(url).split("#")[0]}#t=${Math.round(t * 1000) / 1000}`;
}
