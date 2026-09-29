import { describe, expect, it } from "vitest";
import { inviteExpiryText, lastViewedText, studentLine } from "../../public/js/coaching.js";
import { HEAD_NECK, HELMET_RATINGS, PROFILE_FIELDS, profileBody, profileSections } from "../../public/js/profile.js";
import { HEAD_NECK as SERVER_HEAD_NECK, HELMET_RATINGS as SERVER_HELMET_RATINGS, sanitizeProfile } from "../../src/lib/profile.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 29, 12);

describe("the profile form mirrors sanitizeProfile", () => {
  const sample = {
    text: "Something",
    long: "Something longer",
    year: 2019,
    select: null,
    bool: true,
  };

  it("sends only fields the server keeps, and the server keeps every one it sends", () => {
    const body = Object.fromEntries(
      PROFILE_FIELDS.map((f) => [f.key, f.kind === "select" ? f.options[0][0] : sample[f.kind]])
    );
    const r = sanitizeProfile(body, "2026-09-29");
    expect(r).toHaveProperty("profile");
    expect(Object.keys(r.profile).sort()).toEqual(PROFILE_FIELDS.map((f) => f.key).sort());
  });

  it("offers exactly the server's helmet ratings and restraints", () => {
    expect(HELMET_RATINGS.map(([v]) => v)).toEqual([...SERVER_HELMET_RATINGS]);
    expect(HEAD_NECK.map(([v]) => v)).toEqual([...SERVER_HEAD_NECK]);
  });

  it("caps text at the server's lengths", () => {
    for (const f of PROFILE_FIELDS.filter((x) => x.max)) {
      expect("error" in sanitizeProfile({ [f.key]: "x".repeat(f.max) }, "2026-09-29"), f.key).toBe(false);
      expect("error" in sanitizeProfile({ [f.key]: "x".repeat(f.max + 1) }, "2026-09-29"), f.key).toBe(true);
    }
  });
});

describe("profileBody", () => {
  it("turns blanks into null, the year into a number and yes/no into booleans", () => {
    const body = profileBody({ occupation: "  Pilot ", first_track_year: "2019", helmet_rating: "", gloves: "yes", shoes: "no", goals: "" });
    expect(body.occupation).toBe("Pilot");
    expect(body.first_track_year).toBe(2019);
    expect(body.helmet_rating).toBeNull();
    expect(body.gloves).toBe(true);
    expect(body.shoes).toBe(false);
    expect(body.goals).toBeNull();
    expect(body.experience).toBeNull();
  });

  it("leaves an unanswered yes/no unanswered", () => {
    expect(profileBody({ gloves: "" }).gloves).toBeNull();
    expect(profileBody({}).shoes).toBeNull();
  });
});

describe("profileSections", () => {
  it("says nothing for no profile", () => {
    expect(profileSections(null)).toEqual([]);
    expect(profileSections({})).toEqual([]);
  });

  it("keeps only the groups and rows with something to say, in form order", () => {
    const out = profileSections({ goals: "Trail braking", helmet_rating: "SA2020", gloves: false, occupation: " " });
    expect(out).toEqual([
      {
        title: "Safety gear",
        rows: [
          { key: "helmet_rating", label: "Helmet rating", value: "Snell SA2020" },
          { key: "gloves", label: "Driving gloves", value: "No" },
        ],
      },
      { title: "Coaching", rows: [{ key: "goals", label: "What I want to work on", value: "Trail braking" }] },
    ]);
  });
});

describe("studentLine", () => {
  const iso = (d) => d;
  it("counts events and says when they were last out", () => {
    expect(studentLine({ event_count: 0, last_event_date: null }, iso)).toBe("No track days yet");
    expect(studentLine({ event_count: 1, last_event_date: "2026-04-10" }, iso)).toBe("1 event · last out 2026-04-10");
    expect(studentLine({ event_count: 12, last_event_date: "2026-04-10" }, iso)).toBe("12 events · last out 2026-04-10");
  });
});

describe("lastViewedText", () => {
  it("steps from hours to days to weeks", () => {
    expect(lastViewedText(null, NOW)).toBe("hasn't looked yet");
    expect(lastViewedText(NOW - 10 * 60_000, NOW)).toBe("viewed in the last hour");
    expect(lastViewedText(NOW - HOUR, NOW)).toBe("viewed 1 hour ago");
    expect(lastViewedText(NOW - 23.9 * HOUR, NOW)).toBe("viewed 23 hours ago");
    expect(lastViewedText(NOW - DAY, NOW)).toBe("viewed 1 day ago");
    expect(lastViewedText(NOW - 13.9 * DAY, NOW)).toBe("viewed 13 days ago");
    expect(lastViewedText(NOW - 14 * DAY, NOW)).toBe("viewed 2 weeks ago");
    expect(lastViewedText(NOW - 60 * DAY, NOW)).toBe("not viewed for over two months");
    // A clock a little behind the server's never reads as the future.
    expect(lastViewedText(NOW + 5_000, NOW)).toBe("viewed in the last hour");
  });
});

describe("inviteExpiryText", () => {
  it("rounds days so a fresh link reads seven", () => {
    expect(inviteExpiryText(NOW + 7 * DAY - 1_000, NOW)).toBe("expires in 7 days");
    expect(inviteExpiryText(NOW + 36 * HOUR, NOW)).toBe("expires in 2 days");
    expect(inviteExpiryText(NOW + 25 * HOUR, NOW)).toBe("expires in 1 day");
    expect(inviteExpiryText(NOW + 23.5 * HOUR, NOW)).toBe("expires in 23 hours");
    expect(inviteExpiryText(NOW + HOUR, NOW)).toBe("expires in 1 hour");
    expect(inviteExpiryText(NOW + 59 * 60_000, NOW)).toBe("expires within the hour");
    expect(inviteExpiryText(NOW, NOW)).toBe("expired");
  });
});
