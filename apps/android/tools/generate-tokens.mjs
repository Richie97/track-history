// Generates the Android design tokens from public/style.css.
//
// public/style.css is the source of truth for the design system (NS-07). Rather
// than hand-copying 30-odd values into a Kotlin file — where a typo is invisible
// and a missing token silently falls back to black — this reads the stylesheet's
// dark and light token blocks and writes:
//
//   app/src/main/kotlin/app/trackevolution/ui/theme/ColorTokens.generated.kt
//   app/src/main/kotlin/app/trackevolution/ui/theme/LayoutTokens.generated.kt
//
// The layout half arrived with NS-34: the large-screen work caps the content
// column at the web's `--page-max`, and a number that governs how wide the app
// looks on a tablet has no business being retyped here — it reaches the phones
// the way a colour change does.
//
// The output is committed. Re-run after changing the stylesheet's tokens:
//
//   node apps/android/tools/generate-tokens.mjs
//
// This is the counterpart of apps/ios/Tools/generate-tokens.mjs and reads the
// same two blocks with the same rules, so the two clients cannot drift onto
// different palettes.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ANDROID_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(ANDROID_DIR, "../..");
const CSS = path.join(ROOT, "public", "style.css");
const OUT = path.join(
  ANDROID_DIR,
  "app/src/main/kotlin/app/trackevolution/ui/theme/ColorTokens.generated.kt"
);
const LAYOUT_OUT = path.join(
  ANDROID_DIR,
  "app/src/main/kotlin/app/trackevolution/ui/theme/LayoutTokens.generated.kt"
);

// An alias, not a color of its own: --focus-ring is --accent-ring.
const SKIP = new Set(["--focus-ring"]);

// Named to match the iOS port, so the two token lists diff cleanly.
const RENAME = { "--shadow-color": "shadow" };

const css = readFileSync(CSS, "utf8");

/** The declarations inside the rule whose selector list contains `selector`. */
function block(selector) {
  const index = css.indexOf(selector);
  if (index < 0) throw new Error(`selector not found in style.css: ${selector}`);
  const open = css.indexOf("{", index);
  const close = css.indexOf("}", open);
  if (open < 0 || close < 0) throw new Error(`malformed rule for ${selector}`);
  return css.slice(open + 1, close);
}

/** `--name: value;` pairs, comments stripped. */
function tokens(text) {
  const out = new Map();
  for (const line of text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")) {
    const match = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line);
    if (match && !SKIP.has(match[1])) out.set(match[1], match[2].trim());
  }
  return out;
}

/**
 * A `px` custom property's number, wherever in the stylesheet it is declared.
 *
 * The layout tokens sit in their own plain `:root` block rather than in either
 * of the two theme blocks above, so they are found by name instead of by rule.
 * Exactly one declaration is required: a token redefined in a media query would
 * make "the value" ambiguous, and silently taking the first is how the phones
 * would end up capped at a width the web only uses on a watch.
 *
 * The counterpart of the same function in apps/ios/Tools/generate-tokens.mjs.
 */
function pxToken(name) {
  const matches = [...css.matchAll(new RegExp(`^\\s*${name}\\s*:\\s*([\\d.]+)px\\s*;`, "gim"))];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${name} px declaration in style.css, found ${matches.length}`);
  }
  return Number(matches[0][1]);
}

/** `#rrggbb` or `rgba(r, g, b, a)` → sRGB components in 0…1. */
function parseColor(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value);
  if (rgba) {
    return {
      r: Number(rgba[1]) / 255,
      g: Number(rgba[2]) / 255,
      b: Number(rgba[3]) / 255,
      a: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  throw new Error(`unsupported color syntax: ${value}`);
}

/** `--bg-page` → `bgPage`. */
const kotlinName = (token) =>
  RENAME[token] ?? token.replace(/^--/, "").replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());

const f = (n) => `${n.toFixed(3)}f`;

const color = (value) => {
  const c = parseColor(value);
  return `Color(red = ${f(c.r)}, green = ${f(c.g)}, blue = ${f(c.b)}, alpha = ${f(c.a)})`;
};

const dark = tokens(block(':root,\n[data-theme="dark"]'));
const light = tokens(block('[data-theme="light"]'));

// A token present in only one theme would render as a silent fallback in the
// other — fail loudly instead.
for (const name of dark.keys()) {
  if (!light.has(name)) throw new Error(`${name} is defined for dark but not light`);
}
for (const name of light.keys()) {
  if (!dark.has(name)) throw new Error(`${name} is defined for light but not dark`);
}

const names = [...dark.keys()].sort();

const properties = names.map((token) => `    val ${kotlinName(token)}: Color,`).join("\n");
const scheme = (map) =>
  names.map((token) => `    ${kotlinName(token)} = ${color(map.get(token))},`).join("\n");
const catalog = names
  .map((token) => `    ColorToken("${kotlinName(token)}", "${token}", TrackColors::${kotlinName(token)}),`)
  .join("\n");

writeFileSync(
  OUT,
  `// Generated by apps/android/tools/generate-tokens.mjs from public/style.css.
// Do not edit — change the stylesheet's tokens and re-run the generator.

package app.trackevolution.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/**
 * Every semantic color token in the Track Evolution design system, ported from
 * \`public/style.css\`.
 *
 * The palette is semantic rather than Material: \`surfaceCard\`, \`textMuted\`,
 * \`accentInk\`, \`chartLineB\`, \`mapSlow\` have no counterpart in Material's
 * primary/secondary/tertiary roles, which is why this exists instead of leaning
 * on \`ColorScheme\`. Reach for it through \`TrackTheme.colors\`.
 */
@Immutable
data class TrackColors(
${properties}
)

/** The stylesheet's \`:root, [data-theme="dark"]\` block — the app's default. */
val DarkTrackColors: TrackColors = TrackColors(
${scheme(dark)}
)

/**
 * The stylesheet's \`[data-theme="light"]\` block.
 *
 * Not a lightness flip of the dark scheme: \`accentInk\` is \`#c8f24e\` dark and
 * \`#4c6a00\` light, and the chart series change hue entirely. Deriving one from
 * the other would make light mode unreadable.
 */
val LightTrackColors: TrackColors = TrackColors(
${scheme(light)}
)

/** One token, for the debug token gallery. */
@Immutable
data class ColorToken(
    val name: String,
    /** The custom property this came from, e.g. \`--bg-page\`. */
    val css: String,
    val select: (TrackColors) -> Color,
)

/** Every token, in stylesheet-name order. Drives the gallery. */
val ColorTokenCatalog: List<ColorToken> = listOf(
${catalog}
)
`
);

writeFileSync(
  LAYOUT_OUT,
  `// Generated by apps/android/tools/generate-tokens.mjs from public/style.css.
// Do not edit — change the stylesheet's tokens and re-run the generator.

package app.trackevolution.ui.theme

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Layout dimensions shared with the web app.
 *
 * The colours have been generated since NS-07; this is the first *layout* token,
 * added by NS-34 so that the width the app caps its content at is the same
 * number the web caps its page at, rather than a copy that drifts. The iOS
 * counterpart is \`LayoutTokens.swift\`, generated from the same declarations.
 *
 * In \`dp\`, not \`sp\`: a page width is a physical dimension. A column that grew
 * with the font-size setting would get *wider* exactly when the text needs it
 * narrower.
 */
object LayoutTokens {
    /** \`--page-max\`: how wide the content column is ever allowed to get. */
    val PAGE_MAX: Dp = ${pxToken("--page-max")}.dp

    /** \`--page-gutter\`: the web's page padding, used at medium width and above. */
    val PAGE_GUTTER: Dp = ${pxToken("--page-gutter")}.dp
}
`
);

console.log(`wrote ${names.length} tokens to ${path.relative(ROOT, OUT)}`);
console.log(`wrote ${path.relative(ROOT, LAYOUT_OUT)}`);
