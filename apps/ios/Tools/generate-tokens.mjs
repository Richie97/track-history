// Generates the iOS color tokens from public/style.css.
//
// public/style.css is the source of truth for the design system (NS-06). Rather
// than hand-copying 30-odd hex values into an asset catalog — where a typo is
// invisible and a missing token silently falls back to black — this reads the
// stylesheet's dark and light token blocks and writes:
//
//   App/Assets.xcassets/Colors/<name>.colorset/   one per token, Any + Dark
//   App/DesignSystem/ColorTokens.generated.swift  the token list, for the gallery
//
// Both outputs are committed. Re-run after changing the stylesheet's tokens:
//
//   node apps/ios/Tools/generate-tokens.mjs
//
// Note the appearance mapping: the web app defaults to dark and follows the
// device, so on iOS the *Any* (light) appearance takes the stylesheet's
// [data-theme="light"] values and *Dark* takes its dark defaults.
//
// The Swift side deliberately does not declare `Color` extensions: with
// ASSETCATALOG_COMPILER_GENERATE_ASSET_SYMBOLS on, Xcode already generates
// `ColorResource` symbols from these asset names (`Color(.bgPage)`), and a
// hand-written extension of the same name would collide.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IOS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(IOS_DIR, "../..");
const CSS = path.join(ROOT, "public", "style.css");
const COLORS_DIR = path.join(IOS_DIR, "App", "Assets.xcassets", "Colors");
const SWIFT_OUT = path.join(IOS_DIR, "App", "DesignSystem", "ColorTokens.generated.swift");

// Aliases, not colors of their own: --focus-ring is --accent-ring, and the
// launch background is a separate asset because Info.plist names it literally.
const SKIP = new Set(["--focus-ring"]);

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

// Xcode's asset-symbol generator strips a trailing "Color" from an asset name
// (`shadowColor` would be reachable only as `.shadow`), so name that asset the
// way its symbol will read instead of leaving the two out of step.
const RENAME = { "--shadow-color": "shadow" };

/** `--bg-page` → `bgPage`. */
const swiftName = (token) =>
  RENAME[token] ?? token.replace(/^--/, "").replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());

const f = (n) => n.toFixed(3);

function colorset(light, dark) {
  const entry = (c, appearances) => ({
    ...(appearances ? { appearances } : {}),
    color: {
      "color-space": "srgb",
      components: { red: f(c.r), green: f(c.g), blue: f(c.b), alpha: f(c.a) },
    },
    idiom: "universal",
  });
  return {
    colors: [
      entry(light),
      entry(dark, [{ appearance: "luminosity", value: "dark" }]),
    ],
    info: { author: "xcode", version: 1 },
  };
}

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

rmSync(COLORS_DIR, { recursive: true, force: true });
mkdirSync(COLORS_DIR, { recursive: true });
// No "provides-namespace": the generated symbols should be flat (`.bgPage`,
// not `.colors.bgPage`).
writeFileSync(
  path.join(COLORS_DIR, "Contents.json"),
  JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2) + "\n"
);

const names = [...dark.keys()].sort();
for (const token of names) {
  const dir = path.join(COLORS_DIR, `${swiftName(token)}.colorset`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "Contents.json"),
    JSON.stringify(colorset(parseColor(light.get(token)), parseColor(dark.get(token))), null, 2) + "\n"
  );
}

const rows = names
  .map((token) => `        Token("${swiftName(token)}", css: "${token}", color: Color(.${swiftName(token)})),`)
  .join("\n");

writeFileSync(
  SWIFT_OUT,
  `// Generated by apps/ios/Tools/generate-tokens.mjs from public/style.css.
// Do not edit — change the stylesheet's tokens and re-run the generator.

import SwiftUI

/// Every semantic color token, in the order the stylesheet declares them.
///
/// The colors themselves are reached through the asset-catalog symbols Xcode
/// generates — \`Color(.bgPage)\` — so this list exists for one purpose: the debug
/// token gallery, which renders all of them and is how the port gets reviewed
/// without diffing hex codes by eye.
enum ColorTokens {
    struct Token: Identifiable {
        let name: String
        /// The custom property this came from, e.g. \`--bg-page\`.
        let css: String
        let color: Color

        var id: String { name }

        init(_ name: String, css: String, color: Color) {
            self.name = name
            self.css = css
            self.color = color
        }
    }

    static let all: [Token] = [
${rows}
    ]
}
`
);

console.log(`wrote ${names.length} colorsets to apps/ios/App/Assets.xcassets/Colors/`);
console.log("wrote apps/ios/App/DesignSystem/ColorTokens.generated.swift");
