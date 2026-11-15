import { describe, expect, it } from "vitest";
import {
  ANDROID_CHANNEL,
  PUSH_BODY_MAX,
  commentPushMessage,
  isDeadToken,
  parseFcmServiceAccount,
  pushExcerpt,
  pushRecipient,
  pushTitle,
  sanitizePushDevice,
  type CommentPushRow,
} from "../../src/lib/push";
import { feedLine } from "../../public/js/comments.js";

// NS-54: push notifications for coach comments — the pure half.

const row = (over: Partial<CommentPushRow> = {}): CommentPushRow => ({
  id: 7, student_id: 1, coach_id: 2, author_id: 2, event_id: 30, session_id: 40, lap_id: 50,
  body: "Brake 10 m later here.", author_name: "Sam Lee", track_name: "VIR", session_label: "Session 2", lap_num: 6,
  ...over,
});

describe("sanitizePushDevice", () => {
  it("takes a platform and a token", () => {
    expect(sanitizePushDevice({ platform: "ios", token: "abc:DEF_123-x", extra: 1 })).toEqual({
      device: { platform: "ios", token: "abc:DEF_123-x" },
    });
    expect(sanitizePushDevice({ platform: "android", token: "t" })).toEqual({ device: { platform: "android", token: "t" } });
  });
  it("refuses anything else", () => {
    for (const v of [null, "x", { platform: "web", token: "t" }, { platform: "ios" }, { platform: "ios", token: "" },
      { platform: "ios", token: "has space" }, { platform: "ios", token: "x".repeat(4097) }, { platform: "ios", token: 5 }])
      expect(sanitizePushDevice(v)).toHaveProperty("error");
  });
});

describe("pushExcerpt", () => {
  it("flattens newlines and leaves a short comment whole", () => {
    expect(pushExcerpt("Line one\n\n  line two\n")).toBe("Line one line two");
  });
  it("cuts at PUSH_BODY_MAX code points with an ellipsis", () => {
    const out = pushExcerpt("a".repeat(500));
    expect([...out]).toHaveLength(PUSH_BODY_MAX);
    expect(out.endsWith("…")).toBe(true);
  });
  it("never splits an emoji", () => {
    const out = pushExcerpt("🏁".repeat(300));
    expect([...out]).toHaveLength(PUSH_BODY_MAX);
    expect(out).toBe(`${"🏁".repeat(PUSH_BODY_MAX - 1)}…`);
  });
});

describe("who is told, and in what words", () => {
  it("a coach's comment goes to the student; a reply to the coach", () => {
    expect(pushRecipient(row())).toBe(1);
    expect(pushRecipient(row({ author_id: 1 }))).toBe(2);
  });

  it("says the web feed's line, in both directions", () => {
    const toStudent = row();
    expect(pushTitle(toStudent, 1)).toBe("Sam Lee commented on Lap 6 · VIR");
    expect(pushTitle(toStudent, 1)).toBe(feedLine({ author: { name: "Sam Lee" }, student: null, lap_num: 6, track_name: "VIR" }));
    const toCoach = row({ author_id: 1, author_name: "Alex", lap_id: null, lap_num: null });
    expect(pushTitle(toCoach, 2)).toBe("Alex replied on Session 2 · VIR");
    expect(pushTitle(toCoach, 2)).toBe(
      feedLine({ author: { name: "Alex" }, student: { id: 1 }, lap_num: null, session_label: "Session 2", track_name: "VIR" })
    );
    expect(pushTitle(row({ author_name: null, session_label: null, lap_num: null, track_name: null }), 1)).toBe(
      "Your coach commented on a session"
    );
  });
});

describe("commentPushMessage", () => {
  it("an iOS student: ids to route by, the badge, grouped by event", () => {
    const m = commentPushMessage(row(), { platform: "ios", token: "tok" }, 1, 3);
    expect(m).toEqual({
      token: "tok",
      notification: { title: "Sam Lee commented on Lap 6 · VIR", body: "Brake 10 m later here." },
      data: { kind: "comment", comment_id: "7", event_id: "30", session_id: "40", lap_id: "50" },
      apns: { payload: { aps: { badge: 3, sound: "default", "thread-id": "event-30" } } },
    });
  });
  it("an Android coach: the student's id, the channel, no lap on a session comment", () => {
    const m = commentPushMessage(row({ author_id: 1, lap_id: null, lap_num: null }), { platform: "android", token: "tok" }, 2, 0);
    expect(m.data).toEqual({ kind: "comment", comment_id: "7", event_id: "30", session_id: "40", student_id: "1" });
    expect(m).toMatchObject({ android: { priority: "HIGH", notification: { channel_id: ANDROID_CHANNEL, tag: "event-30" } } });
    expect(m).not.toHaveProperty("apns");
  });
  it("every data value is a string, as FCM requires", () => {
    const m = commentPushMessage(row({ author_id: 1 }), { platform: "ios", token: "t" }, 2, 1);
    expect(Object.values(m.data).every((v) => typeof v === "string")).toBe(true);
  });
});

describe("isDeadToken", () => {
  it("a gone app or a malformed token removes the device", () => {
    expect(isDeadToken(404, { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } })).toBe(true);
    expect(isDeadToken(404, null)).toBe(true);
    expect(isDeadToken(400, { error: { status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" } })).toBe(true);
  });
  it("anything that isn't the device's fault keeps it", () => {
    expect(isDeadToken(400, { error: { status: "INVALID_ARGUMENT", message: "Invalid JSON payload" } })).toBe(false);
    expect(isDeadToken(401, { error: { status: "UNAUTHENTICATED" } })).toBe(false);
    expect(isDeadToken(403, { error: { details: [{ errorCode: "SENDER_ID_MISMATCH" }] } })).toBe(false);
    expect(isDeadToken(429, { error: { details: [{ errorCode: "QUOTA_EXCEEDED" }] } })).toBe(false);
    expect(isDeadToken(503, null)).toBe(false);
  });
});

describe("parseFcmServiceAccount", () => {
  it("needs the project id beside the key", () => {
    const sa = { client_email: "x@y.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----" };
    expect(parseFcmServiceAccount(JSON.stringify({ ...sa, project_id: "track-evolution-app" }))).toMatchObject({
      project_id: "track-evolution-app",
    });
    expect(parseFcmServiceAccount(JSON.stringify(sa))).toBeNull();
    expect(parseFcmServiceAccount(JSON.stringify({ ...sa, project_id: "../evil" }))).toBeNull();
    expect(parseFcmServiceAccount(undefined)).toBeNull();
    expect(parseFcmServiceAccount("{nope")).toBeNull();
  });
});
