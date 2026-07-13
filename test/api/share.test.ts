import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createEvent, signedInUser } from "./helpers";

async function publicShare(slug: string) {
  const res = await SELF.fetch(`https://example.com/api/share/${slug}`);
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe("PUT /api/share", () => {
  it("sets a share slug (normalised to lowercase)", async () => {
    const { api } = await signedInUser();
    const res = await api("PUT", "/share", { slug: "  My-Laps  " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug: "my-laps" });
    expect((await api("GET", "/me")).body.user.share_slug).toBe("my-laps");
  });

  it("rejects invalid slugs", async () => {
    const { api } = await signedInUser();
    for (const slug of ["", "ab", "-abc", "abc-", "a b", "a".repeat(33)]) {
      expect((await api("PUT", "/share", { slug })).status, slug).toBe(400);
    }
  });

  it("rejects a slug already taken by another user", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    expect((await a.api("PUT", "/share", { slug: "taken-slug" })).status).toBe(200);
    const res = await b.api("PUT", "/share", { slug: "taken-slug" });
    expect(res.status).toBe(409);
  });
});

describe("GET /api/share/:slug (public)", () => {
  it("serves the user's stats without authentication", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { best_time_ms: 121000, club: "VIR Club", notes: "secret notes" });
    await api("PUT", "/share", { slug: "public-driver" });

    const { status, body } = await publicShare("public-driver");
    expect(status).toBe(200);
    expect(body.totals.events).toBe(1);
    expect(body.tracks).toHaveLength(1);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].best_ms).toBe(121000);
    expect(body.events[0].club).toBe("VIR Club");
  });

  it("strips private data: notes, email and per-lap detail", async () => {
    const { api, email } = await signedInUser();
    const eventId = await createEvent(api, { notes: "secret notes" });
    await api("POST", `/events/${eventId}/sessions`, { notes: "session secret", laps: [121000] });
    await api("PUT", "/share", { slug: "privacy-check" });

    const { body } = await publicShare("privacy-check");
    expect(body.events[0]).not.toHaveProperty("notes");
    expect(body.events[0]).not.toHaveProperty("sessions");
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("secret notes");
    expect(raw).not.toContain("session secret");
    expect(raw).not.toContain(email);
  });

  it("matches slugs case-insensitively via lowercasing", async () => {
    const { api } = await signedInUser();
    await api("PUT", "/share", { slug: "case-slug" });
    expect((await publicShare("CASE-SLUG")).status).toBe(200);
  });

  it("404s for unknown slugs", async () => {
    expect((await publicShare("does-not-exist")).status).toBe(404);
  });
});

describe("DELETE /api/share", () => {
  it("disables the public page", async () => {
    const { api } = await signedInUser();
    await api("PUT", "/share", { slug: "soon-gone" });
    expect((await publicShare("soon-gone")).status).toBe(200);
    expect((await api("DELETE", "/share")).status).toBe(200);
    expect((await publicShare("soon-gone")).status).toBe(404);
    expect((await api("GET", "/me")).body.user.share_slug).toBeNull();
  });

  it("share management endpoints require auth", async () => {
    const res = await SELF.fetch("https://example.com/api/share", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "sneaky" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/share/:slug privacy for new fields", () => {
  it("shares conditions but strips course notes and checklists", async () => {
    const { api } = await signedInUser();
    await createEvent(api, {
      track_name: "VIR",
      track_config: "Full",
      conditions: "dry",
      temp_f: 72,
      checklist: [{ text: "secret prep item", done: false }],
    });
    const track = (await api("GET", "/tracks")).body[0];
    await api("PUT", `/tracks/${track.id}`, { notes: "secret course notes" });
    await api("PUT", "/share", { slug: "fields-check" });

    const { body } = await publicShare("fields-check");
    expect(body.events[0].conditions).toBe("dry");
    expect(body.events[0].track_config).toBe("Full");
    expect(body.tracks[0].config).toBe("Full");
    expect(body.events[0]).not.toHaveProperty("checklist");
    expect(body.tracks[0]).not.toHaveProperty("notes");
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("secret prep item");
    expect(raw).not.toContain("secret course notes");
  });
});
