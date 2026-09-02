// The synthetic chains from build.sh as strings, for tests that run in Node
// (unit tests, and the vitest workers config, which hands them to the API
// tests as bindings — workerd has no filesystem).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(path.join(dir, name), "utf8");

export const chain = {
  leaf: read("leaf.pem"),
  leafKey: read("leaf-key.pem"),
  intermediate: read("intermediate.pem"),
  root: read("root.pem"),
};
export const leafNoExt = { leaf: read("leaf-noext.pem"), leafKey: read("leaf-noext-key.pem") };
export const otherChain = {
  leaf: read("other-leaf.pem"),
  leafKey: read("other-leaf-key.pem"),
  intermediate: read("other-intermediate.pem"),
  root: read("other-root.pem"),
};
