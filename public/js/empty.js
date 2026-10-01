// What a page or a section says when it has nothing to show (#342) — one
// shape on every page, so an empty list reads as "nothing here yet, and this is
// the next step" rather than as a sentence that happens to be grey.
//
// The native apps' `TEEmpty` takes the same three parts: an optional title, the
// sentence, and an optional action.

import { esc } from "./format.js";

/**
 * @param {object} opts
 * @param {string} [opts.title]   plain text, escaped here
 * @param {string} opts.body      HTML — the caller escapes any user data in it,
 *                                because some bodies carry a link
 * @param {{ label: string, href?: string, id?: string }} [opts.action]
 *                                a link when it has `href`, else a button the
 *                                caller binds by `id`
 * @param {boolean} [opts.compact] inside a panel: left-aligned, no padding of its own
 */
export function emptyHtml({ title, body, action, compact = false } = {}) {
  const cls = compact ? "empty empty-compact" : "empty";
  const titleHtml = title ? `<div class="empty-title">${esc(title)}</div>` : "";
  const bodyHtml = body ? `<div class="empty-body">${body}</div>` : "";
  let actionHtml = "";
  if (action) {
    const control = action.href
      ? `<a class="btn small primary" href="${esc(action.href)}">${esc(action.label)}</a>`
      : `<button type="button" class="btn small primary"${action.id ? ` id="${esc(action.id)}"` : ""}>${esc(action.label)}</button>`;
    actionHtml = `<div class="empty-action">${control}</div>`;
  }
  return `<div class="${cls}">${titleHtml}${bodyHtml}${actionHtml}</div>`;
}

/**
 * The event an "Import a session" action opens when a lap view has no
 * telemetry to show: the most recent one at the track that has started —
 * where a recording or a logger file from that day belongs. Null when every
 * event there is still upcoming (or there are none), and the caller offers
 * "Add an event" instead.
 *
 * @param {{ id: number|string, start_date: string }[]} events  one track's events
 * @param {string} today  YYYY-MM-DD
 */
export function importTargetEvent(events, today) {
  let best = null;
  for (const e of events) {
    if (e.start_date > today) continue;
    if (!best || e.start_date > best.start_date) best = e;
  }
  return best;
}
