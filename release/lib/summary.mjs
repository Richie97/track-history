// Lines for the run's job summary (GITHUB_STEP_SUMMARY), echoed to the log as
// well so a local run shows the same thing.

import { appendFileSync } from "node:fs";

export function summary(title) {
  const lines = [`### ${title}`, ""];
  return {
    line(text = "") {
      lines.push(text);
      console.log(text);
    },
    lines(texts) {
      for (const t of texts) this.line(t);
    },
    flush() {
      const file = process.env.GITHUB_STEP_SUMMARY;
      if (file) appendFileSync(file, lines.join("\n") + "\n");
    },
  };
}

// Inputs reach the scripts as environment variables (never interpolated into
// the workflow's shell), and an empty dispatch input arrives as "".
export function input(name) {
  const value = process.env[name];
  return value == null || value.trim() === "" ? null : value.trim();
}

export function required(name, hint) {
  const value = input(name);
  if (!value) throw new Error(`${name} is not set. ${hint}`);
  return value;
}
