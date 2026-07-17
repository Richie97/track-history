#!/usr/bin/env node
// Builds www/ (the Capacitor webDir) from ../public, which stays the single
// source of truth for the frontend. Never edit www/ by hand. Differences from
// the web build:
//   - sw.js and .well-known/ are dropped (no service worker in the native
//     shell; association files are a server concern)
//   - overrides/native.js is added and replaces app.js as the module entry
//     (it configures js/platform.js, then imports app.js)

import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformIndexHtml } from "./transform.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url))); // mobile/
const publicDir = join(root, "..", "public");
const www = join(root, "www");

rmSync(www, { recursive: true, force: true });
mkdirSync(www);
cpSync(publicDir, www, {
  recursive: true,
  filter: (src) => !src.endsWith("/sw.js") && !src.includes("/.well-known"),
});

copyFileSync(join(root, "overrides", "native.js"), join(www, "native.js"));

const indexPath = join(www, "index.html");
writeFileSync(indexPath, transformIndexHtml(readFileSync(indexPath, "utf8")));

console.log("mobile/www synced from public/");
