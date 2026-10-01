import { describe, expect, it } from "vitest";
import { emptyHtml, importTargetEvent } from "../../public/js/empty.js";

describe("emptyHtml", () => {
  it("is the sentence alone when that is all there is", () => {
    expect(emptyHtml({ body: "No sessions recorded yet." })).toBe(
      '<div class="empty"><div class="empty-body">No sessions recorded yet.</div></div>'
    );
  });

  it("escapes the title and the action but leaves the body's HTML to the caller", () => {
    const html = emptyHtml({
      title: "<b>No events</b>",
      body: 'See <a href="#/">the dashboard</a>',
      action: { label: "Add <one>", href: "#/new?track=A&B" },
    });
    expect(html).toContain('<div class="empty-title">&lt;b&gt;No events&lt;/b&gt;</div>');
    expect(html).toContain('<div class="empty-body">See <a href="#/">the dashboard</a></div>');
    expect(html).toContain('<a class="btn small primary" href="#/new?track=A&amp;B">Add &lt;one&gt;</a>');
  });

  it("renders a button the caller binds when the action has no href", () => {
    expect(emptyHtml({ body: "x", action: { label: "Join", id: "lb-join" } })).toContain(
      '<button type="button" class="btn small primary" id="lb-join">Join</button>'
    );
  });

  it("marks the compact form for use inside a panel", () => {
    expect(emptyHtml({ body: "No assistants connected.", compact: true })).toMatch(/^<div class="empty empty-compact">/);
  });
});

describe("importTargetEvent", () => {
  const today = "2026-10-01";

  it("picks the most recent event that has started, whatever order they arrive in", () => {
    const events = [
      { id: 1, start_date: "2026-04-02" },
      { id: 3, start_date: "2026-11-20" },
      { id: 2, start_date: "2026-09-12" },
    ];
    expect(importTargetEvent(events, today)?.id).toBe(2);
  });

  it("counts an event starting today as started", () => {
    expect(importTargetEvent([{ id: 7, start_date: today }], today)?.id).toBe(7);
  });

  it("is null when everything is still upcoming, or there is nothing", () => {
    expect(importTargetEvent([{ id: 1, start_date: "2026-12-01" }], today)).toBeNull();
    expect(importTargetEvent([], today)).toBeNull();
  });
});
