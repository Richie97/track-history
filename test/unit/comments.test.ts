import { describe, expect, it } from "vitest";
import {
  COMMENT_MAX_CHARS,
  MAX_DIST_M,
  commentView,
  sanitizeComment,
  sanitizeCommentBody,
  type CommentRow,
} from "../../src/lib/comments";

// NS-52: the pure half of coach comments.

describe("sanitizeCommentBody", () => {
  it("trims, and keeps newlines", () => {
    expect(sanitizeCommentBody("  Brake later.\r\nTrust the car.  ")).toEqual({ body: "Brake later.\nTrust the car." });
  });

  it("refuses an empty or non-text body", () => {
    expect(sanitizeCommentBody("   \n ")).toHaveProperty("error");
    expect(sanitizeCommentBody(null)).toHaveProperty("error");
    expect(sanitizeCommentBody(12)).toHaveProperty("error");
  });

  it("refuses control characters, a tab included", () => {
    expect(sanitizeCommentBody("a\u0000b")).toHaveProperty("error");
    expect(sanitizeCommentBody("a\tb")).toHaveProperty("error");
    expect(sanitizeCommentBody("a\u007Fb")).toHaveProperty("error");
  });

  it("counts code points, not UTF-16 units", () => {
    // Each of these is two UTF-16 units and one character.
    expect(sanitizeCommentBody("🏁".repeat(COMMENT_MAX_CHARS))).toEqual({ body: "🏁".repeat(COMMENT_MAX_CHARS) });
    expect(sanitizeCommentBody("🏁".repeat(COMMENT_MAX_CHARS + 1))).toHaveProperty("error");
    expect(sanitizeCommentBody("x".repeat(COMMENT_MAX_CHARS + 1))).toHaveProperty("error");
  });
});

describe("sanitizeComment", () => {
  it("takes a session comment, a lap comment and a placed one", () => {
    expect(sanitizeComment({ body: "Good session" })).toEqual({ comment: { body: "Good session", lap_id: null, dist_m: null } });
    expect(sanitizeComment({ body: "Tidy", lap_id: 7 })).toEqual({ comment: { body: "Tidy", lap_id: 7, dist_m: null } });
    expect(sanitizeComment({ body: "Here", lap_id: 7, dist_m: 0 })).toEqual({ comment: { body: "Here", lap_id: 7, dist_m: 0 } });
  });

  it("drops unknown keys, the thread's ids among them", () => {
    const out = sanitizeComment({ body: "x", coach_id: 3, author_id: 4, student_id: 5, event_id: 6, seen_at: 1 });
    expect(out).toEqual({ comment: { body: "x", lap_id: null, dist_m: null } });
  });

  it("refuses a place with no lap, and a place that isn't whole metres in range", () => {
    expect(sanitizeComment({ body: "x", dist_m: 100 })).toEqual({ error: "a place needs a lap" });
    for (const dist_m of [-1, 1.5, MAX_DIST_M + 1, "120", NaN]) {
      expect(sanitizeComment({ body: "x", lap_id: 1, dist_m })).toHaveProperty("error");
    }
    expect(sanitizeComment({ body: "x", lap_id: 1, dist_m: MAX_DIST_M })).toHaveProperty("comment");
  });

  it("refuses a lap id that isn't one", () => {
    for (const lap_id of [0, -3, 1.2, "7", {}]) expect(sanitizeComment({ body: "x", lap_id })).toHaveProperty("error");
  });

  it("refuses anything that isn't an object", () => {
    for (const v of [null, undefined, "x", 3, []]) expect(sanitizeComment(v)).toHaveProperty("error");
  });
});

describe("commentView", () => {
  const row: CommentRow & { email: string } = {
    id: 9, student_id: 1, coach_id: 2, author_id: 2, event_id: 3, session_id: 4, lap_id: 5, dist_m: 1240,
    body: "Brake later", created_at: 1000, edited_at: null, seen_at: null,
    author_name: "Sam Lee", author_picture: null, email: "sam@example.com",
  };

  it("copies the allowed fields and nothing else", () => {
    expect(commentView(row, 1)).toEqual({
      id: 9, coach_id: 2, session_id: 4, lap_id: 5, dist_m: 1240, body: "Brake later", created_at: 1000, edited_at: null,
      author: { id: 2, name: "Sam Lee", picture: null }, mine: false, seen: false,
    });
  });

  it("says whose it is and whether it has been read", () => {
    expect(commentView(row, 2).mine).toBe(true);
    expect(commentView({ ...row, seen_at: 5 }, 2).seen).toBe(true);
  });
});
