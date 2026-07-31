import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { apiClient, signedInUser } from "./helpers";

describe("GET /api/me", () => {
  it("returns the signed-in user with no checklist template by default", async () => {
    const { api, email } = await signedInUser();
    const res = await api("GET", "/me");
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    // null, not [] — "I haven't customized this" is what puts the app's built-in
    // default in front of the user.
    expect(res.body.user.checklist_template).toBeNull();
  });

  it("returns a saved template as an array", async () => {
    const { api } = await signedInUser();
    await api("PUT", "/me/checklist-template", {
      checklist_template: ["Purchase track insurance", "Torque lug nuts"],
    });
    const res = await api("GET", "/me");
    expect(res.body.user.checklist_template).toEqual([
      "Purchase track insurance",
      "Torque lug nuts",
    ]);
  });

  it("degrades a malformed stored template to null rather than failing the request", async () => {
    const { api, id } = await signedInUser();
    await env.DB.prepare("UPDATE users SET checklist_template = ? WHERE id = ?")
      .bind("{not json", id)
      .run();
    const res = await api("GET", "/me");
    expect(res.status).toBe(200);
    expect(res.body.user.checklist_template).toBeNull();
  });
});

describe("PUT /api/me/checklist-template", () => {
  it("saves a template and keeps its order", async () => {
    const { api } = await signedInUser();
    const items = ["Tech inspection", "Purchase track insurance", "Top off fuel"];
    const res = await api("PUT", "/me/checklist-template", { checklist_template: items });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect((await api("GET", "/me")).body.user.checklist_template).toEqual(items);
  });

  it("trims items", async () => {
    const { api } = await signedInUser();
    await api("PUT", "/me/checklist-template", { checklist_template: ["  Torque lug nuts  "] });
    expect((await api("GET", "/me")).body.user.checklist_template).toEqual(["Torque lug nuts"]);
  });

  it("clears the template with null or an empty list", async () => {
    const { api } = await signedInUser();
    await api("PUT", "/me/checklist-template", { checklist_template: ["Only item"] });
    await api("PUT", "/me/checklist-template", { checklist_template: null });
    expect((await api("GET", "/me")).body.user.checklist_template).toBeNull();

    await api("PUT", "/me/checklist-template", { checklist_template: ["Only item"] });
    // Deleting the last item must leave the built-in default behind, not an
    // empty list the user can't get out of.
    await api("PUT", "/me/checklist-template", { checklist_template: [] });
    expect((await api("GET", "/me")).body.user.checklist_template).toBeNull();
  });

  it("rejects anything that isn't a list of non-empty strings", async () => {
    const { api } = await signedInUser();
    const bad = [
      "not an array",
      [{ text: "an event checklist item", done: false }],
      ["  "],
      [""],
      [123],
      ["x".repeat(201)],
      Array.from({ length: 101 }, (_, i) => `item ${i}`),
    ];
    for (const checklist_template of bad) {
      const res = await api("PUT", "/me/checklist-template", { checklist_template });
      expect(res.status, JSON.stringify(checklist_template).slice(0, 40)).toBe(400);
    }
  });

  it("is per user", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    await a.api("PUT", "/me/checklist-template", { checklist_template: ["A's item"] });
    expect((await b.api("GET", "/me")).body.user.checklist_template).toBeNull();
    expect((await a.api("GET", "/me")).body.user.checklist_template).toEqual(["A's item"]);
  });

  it("needs a session", async () => {
    const anon = apiClient();
    expect((await anon("PUT", "/me/checklist-template", { checklist_template: [] })).status).toBe(401);
    expect((await anon("GET", "/me")).status).toBe(401);
  });
});
