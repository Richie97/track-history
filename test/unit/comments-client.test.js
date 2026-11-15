import { describe, expect, it } from "vitest";
import * as server from "../../src/lib/comments.ts";
import {
  COMMENT_MAX_CHARS,
  canReply,
  commentCountText,
  commentCounts,
  commentError,
  commentLength,
  commentMarkers,
  commentPlace,
  commentThreads,
  commentWhen,
  feedLine,
  groupComments,
  placeFromCursor,
  threadTitle,
  unreadLine,
} from "../../public/js/comments.js";

// NS-52: the client's pure half of coach comments.

const c = (id, over = {}) => ({
  id, coach_id: 2, session_id: 10, lap_id: null, dist_m: null, body: `c${id}`, created_at: id * 1000,
  author: { id: 2, name: "Sam Lee" }, mine: false, seen: false, ...over,
});
const session = { id: 10, laps: [{ id: 101, lap_num: 1, time_ms: 95000 }, { id: 102, lap_num: 2, time_ms: 94000 }] };

describe("the limit", () => {
  it("is the server's", () => {
    expect(COMMENT_MAX_CHARS).toBe(server.COMMENT_MAX_CHARS);
  });
  it("is counted the server's way", () => {
    expect(commentLength("  🏁🏁\r\n ok ")).toBe(6);
    expect(commentLength(null)).toBe(0);
  });
});

describe("commentThreads", () => {
  it("splits by coach, in the order each first spoke", () => {
    const out = commentThreads([c(1, { coach_id: 7 }), c(2), c(3, { coach_id: 7 })]);
    expect(out.map((t) => [t.coach_id, t.comments.map((x) => x.id)])).toEqual([[7, [1, 3]], [2, [2]]]);
    expect(commentThreads(null)).toEqual([]);
  });
});

describe("groupComments", () => {
  it("puts the session's first, then laps in lap order, a lap's by place then time", () => {
    const list = [
      c(1, { lap_id: 102 }),
      c(2, { lap_id: 102, dist_m: 900 }),
      c(3),
      c(4, { lap_id: 101 }),
      c(5, { lap_id: 102, dist_m: 300 }),
      c(6, { session_id: 11 }),
      c(7, { lap_id: 999 }),
    ];
    const out = groupComments(list, session);
    expect(out.session.map((x) => x.id)).toEqual([3]);
    expect(out.laps.map((l) => [l.lap_num, l.comments.map((x) => x.id)])).toEqual([[1, [4]], [2, [5, 2, 1]]]);
  });
});

describe("commentCounts", () => {
  it("counts per session and lap, and never counts your own as unread", () => {
    const out = commentCounts([c(1), c(2, { lap_id: 101, seen: true }), c(3, { lap_id: 101 }), c(4, { lap_id: 101, mine: true })]);
    expect(out.bySession[10]).toEqual({ count: 4, unread: 2 });
    expect(out.byLap[101]).toEqual({ count: 3, unread: 1 });
    expect(commentCountText(out.byLap[101])).toBe("3 comments, 1 unread");
    expect(commentCountText({ count: 1, unread: 0 })).toBe("1 comment");
    expect(commentCountText(undefined)).toBe("");
  });
});

describe("places", () => {
  const corners = [{ n: 1, k0: 10, k1: 20 }, { n: 2, k0: 55, k1: 70 }];
  it("says the corner and the distance", () => {
    expect(commentPlace(1240, 20, corners, "metric")).toBe("in T2 · 1.2 km");
    expect(commentPlace(600, 20, corners, "metric")).toBe("after T1 · 600 m");
    expect(commentPlace(600, 20, [], "metric")).toBe("600 m");
    expect(commentPlace(null, 20, corners, "metric")).toBeNull();
  });
  it("turns a cursor into whole metres", () => {
    expect(placeFromCursor(62.04, 20)).toBe(1241);
    expect(placeFromCursor(-1, 20)).toBe(0);
    expect(placeFromCursor(NaN, 20)).toBeNull();
    expect(placeFromCursor(3, 0)).toBeNull();
  });
  it("marks a lap's placed comments, clamped to the lap", () => {
    const list = [c(1, { lap_id: 101, dist_m: 2000, mine: true }), c(2, { lap_id: 101, dist_m: 500 }), c(3, { lap_id: 101 }), c(4, { lap_id: 102, dist_m: 5 })];
    expect(commentMarkers(list, 101, 1000)).toEqual([{ id: 2, frac: 0.5, mine: false }, { id: 1, frac: 1, mine: true }]);
    expect(commentMarkers(list, 101, 0)).toEqual([]);
  });
});

describe("the words", () => {
  it("titles a thread", () => {
    expect(threadTitle({ name: "Sam Lee", active: true }, true)).toBe("Sam Lee");
    expect(threadTitle({ name: "Sam Lee", active: false }, true)).toBe("Sam Lee · no longer your coach");
    expect(threadTitle(null, true)).toBe("Your coach");
    expect(threadTitle({ name: "Sam Lee", active: true }, false)).toBe("Your comments");
    expect(canReply({ active: true })).toBe(true);
    expect(canReply({ active: false })).toBe(false);
    expect(canReply(undefined)).toBe(false);
  });
  it("words a failed send", () => {
    expect(commentError(null)).toBe("Commenting needs a connection.");
    expect(commentError(429)).toMatch(/minute/);
    expect(commentError(409)).toMatch(/as many comments/);
    expect(commentError(404)).toMatch(/any more/);
    expect(commentError(400, "a comment can't be empty")).toBe("a comment can't be empty");
  });
  it("says when, until a date says it better", () => {
    const now = 10 * 24 * 3600 * 1000;
    expect(commentWhen(now - 5000, now)).toBe("just now");
    expect(commentWhen(now - 5 * 60000, now)).toBe("5 min ago");
    expect(commentWhen(now - 3600000, now)).toBe("1 hour ago");
    expect(commentWhen(now - 3 * 86400000, now)).toBe("3 days ago");
    expect(commentWhen(now - 8 * 86400000, now)).toBeNull();
  });
  it("words the feed", () => {
    const mine = { ...c(1), student: null, track_name: "VIR", lap_num: 6, session_label: "Session 2" };
    const theirs = { ...c(2, { author: { id: 9, name: "Alex R." } }), student: { id: 9, name: "Alex R." }, track_name: "VIR", lap_num: null, session_label: "Session 2" };
    expect(feedLine(mine)).toBe("Sam Lee commented on Lap 6 · VIR");
    expect(feedLine(theirs)).toBe("Alex R. replied on Session 2 · VIR");
    expect(unreadLine({ unread: 0, comments: [{ ...mine, seen: true }] })).toBeNull();
    expect(unreadLine({ unread: 1, comments: [mine] })).toBe("Sam Lee commented on Lap 6 · VIR");
    expect(unreadLine({ unread: 2, comments: [mine, { ...mine, id: 5 }] })).toBe("2 new comments from Sam Lee");
    expect(unreadLine({ unread: 2, comments: [mine, theirs] })).toBe("2 new comments from 2 people");
    // More unread than the feed's page holds.
    expect(unreadLine({ unread: 60, comments: [mine] })).toBe("60 new comments from Sam Lee");
  });
});
