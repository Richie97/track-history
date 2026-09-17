// Generates the car_catalog migration (#221) from three inputs beside this file:
//
//   list.json      — the generations the catalog covers, deliberately short and
//                    track-day-shaped. Each entry names the make / model /
//                    generation and where its wheelbase comes from: a Wikidata
//                    item (property P3039, pulled by `--refresh` into
//                    wikidata.json) or, where Wikidata has nothing usable, a
//                    cited manufacturer figure in mm or inches.
//   steering.json  — the hand-curated half: one entry per generation with the
//                    steering ratio and a citation (press kit, spec sheet URL).
//                    A ratio with no citation is refused. A rack the maker only
//                    quotes as a *range* (variable-ratio steering) gets
//                    `ratio: null` and a note saying so — the one thing this
//                    table must never hold is a guess.
//   wikidata.json  — the committed snapshot of what Wikidata answered, so the
//                    migration regenerates byte-identically offline and a
//                    changed figure shows up as a diff in review rather than a
//                    silent rewrite.
//
// Hand-typing the table is how a wrong number gets in, so nothing here is
// typed twice: the committed migration is the artifact, this script is how it
// is refreshed, and nothing at runtime depends on Wikidata.
//
//   node seed/cars/generate.mjs              # rewrite migrations/0024_car_catalog.sql
//   node seed/cars/generate.mjs --refresh    # re-pull wikidata.json first
//   node seed/cars/generate.mjs --append migrations/00NN_car_catalog_more.sql
//       # once 0024 has been applied remotely, additions go in a NEW migration:
//       # emits INSERTs only for generations no earlier catalog migration holds
//
// `test/unit/car-catalog.test.js` checks every generated row against the
// server's validation ranges, that every ratio is cited, and that the
// committed migrations carry exactly the rows this script would emit.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(dir, "..", "..");
export const MIGRATIONS_DIR = join(ROOT, "migrations");
export const DEFAULT_MIGRATION = join(MIGRATIONS_DIR, "0024_car_catalog.sql");

// Mirrors WHEELBASE_MM_RANGE / STEERING_RATIO_RANGE in src/lib/validate.ts —
// the unit test asserts the two agree, so a widened server range that this
// forgets fails there rather than at pick time.
export const WHEELBASE_MM_RANGE = [1500, 4500];
export const STEERING_RATIO_RANGE = [5, 30];

const MM_PER_INCH = 25.4;

// Wikidata quantity units P3039 has been seen with, to millimetres.
const UNIT_TO_MM = {
  "http://www.wikidata.org/entity/Q174789": 1, // millimetre
  "http://www.wikidata.org/entity/Q174728": 10, // centimetre
  "http://www.wikidata.org/entity/Q11573": 1000, // metre
  "http://www.wikidata.org/entity/Q218593": MM_PER_INCH, // inch
};

const USER_AGENT = "track-history-seed/1 (https://github.com/Richie97/track-history)";

export const readJson = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));

export const rowKey = ({ make, model, generation }) => `${make}|${model}|${generation ?? ""}`;

// ---------------------------------------------------------------------------
// Wikidata
// ---------------------------------------------------------------------------

// One P3039 value per item, converted to mm. Two *different* values on one
// item (the Subaru BRZ item carries both generations' figures) are ambiguous
// and count as absent, so the list has to say which one it means.
export function wheelbaseFromClaims(claims) {
  const values = new Set();
  for (const claim of claims?.P3039 ?? []) {
    const v = claim.mainsnak?.datavalue?.value;
    if (!v) continue;
    const factor = UNIT_TO_MM[v.unit];
    if (!factor) throw new Error(`P3039 in an unknown unit: ${v.unit}`);
    values.add(Math.round(Number(v.amount) * factor));
  }
  return values.size === 1 ? [...values][0] : null;
}

async function fetchWikidata(ids) {
  const out = {};
  // The API takes up to 50 ids per call.
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const url = new URL("https://www.wikidata.org/w/api.php");
    url.search = new URLSearchParams({
      action: "wbgetentities",
      ids: batch.join("|"),
      props: "claims|labels",
      languages: "en",
      format: "json",
    });
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`Wikidata answered ${res.status}`);
    const { entities } = await res.json();
    for (const id of batch) {
      const e = entities?.[id];
      if (!e || e.missing !== undefined) throw new Error(`Wikidata has no item ${id}`);
      out[id] = { label: e.labels?.en?.value ?? null, wheelbase_mm: wheelbaseFromClaims(e.claims) };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

function fail(entry, msg) {
  throw new Error(`${rowKey(entry)}: ${msg}`);
}

// The wheelbase and its provenance for one list entry. A cited manual figure
// wins over Wikidata so a known-bad Wikidata value can be overridden in the
// list without editing the snapshot; the source line says which was used.
function resolveWheelbase(entry, wikidata) {
  const manual = entry.wheelbase;
  if (manual) {
    if (!manual.source) fail(entry, "a manual wheelbase needs a source");
    if (manual.mm != null && manual.in != null) fail(entry, "give the wheelbase in mm or in, not both");
    if (manual.mm != null) {
      if (!Number.isInteger(manual.mm)) fail(entry, "wheelbase.mm must be an integer");
      return { mm: manual.mm, source: `wheelbase ${manual.mm} mm: ${manual.source}` };
    }
    if (manual.in != null) {
      const mm = Math.round(manual.in * MM_PER_INCH);
      return { mm, source: `wheelbase ${manual.in} in (${mm} mm): ${manual.source}` };
    }
    fail(entry, "wheelbase needs mm or in");
  }
  if (!entry.wikidata) fail(entry, "needs either a wikidata item or a cited wheelbase");
  const snap = wikidata[entry.wikidata];
  if (!snap) fail(entry, `no snapshot for ${entry.wikidata} — run with --refresh`);
  if (snap.wheelbase_mm == null)
    fail(entry, `Wikidata ${entry.wikidata} has no single wheelbase (P3039); give a cited one`);
  return { mm: snap.wheelbase_mm, source: `wheelbase ${snap.wheelbase_mm} mm: Wikidata ${entry.wikidata} (P3039)` };
}

function resolveSteering(entry, steering) {
  const s = steering[rowKey(entry)];
  if (!s) return { ratio: null, source: "steering ratio: not curated" };
  if (s.ratio != null) {
    if (!s.source) fail(entry, "a steering ratio needs a citation");
    if (typeof s.ratio !== "number" || !Number.isFinite(s.ratio)) fail(entry, "steering ratio must be a number");
    return { ratio: s.ratio, source: `steering ratio ${s.ratio}:1: ${s.source}` };
  }
  if (!s.note) fail(entry, "a null steering ratio needs a note saying why");
  return { ratio: null, source: `steering ratio: ${s.note}${s.source ? ` (${s.source})` : ""}` };
}

// The rows a set of inputs describes, in the order they will be inserted —
// the list's order, which is also the ids' order.
export function buildRows(list, steering, wikidata) {
  const seen = new Set();
  const rows = list.map((entry) => {
    const key = rowKey(entry);
    if (seen.has(key)) fail(entry, "listed twice");
    seen.add(key);
    if (!entry.make || !entry.model) fail(entry, "make and model are required");
    const [from, to] = entry.years ?? [];
    if (!Number.isInteger(from)) fail(entry, "years[0] must be the first model year");
    if (to != null && (!Number.isInteger(to) || to < from)) fail(entry, "years[1] must be null or >= years[0]");
    const wb = resolveWheelbase(entry, wikidata);
    const st = resolveSteering(entry, steering);
    return {
      make: entry.make,
      model: entry.model,
      generation: entry.generation ?? null,
      year_from: from,
      year_to: to ?? null,
      wheelbase_mm: wb.mm,
      steering_ratio: st.ratio,
      source: `${wb.source}; ${st.source}`,
    };
  });
  for (const key of Object.keys(steering)) {
    if (!seen.has(key)) throw new Error(`steering.json names a generation the list doesn't have: ${key}`);
  }
  return rows;
}

const q = (s) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
const n = (v) => (v == null ? "NULL" : String(v));

export const renderInsert = (r) =>
  `INSERT INTO car_catalog (make, model, generation, year_from, year_to, wheelbase_mm, steering_ratio, source) VALUES ` +
  `(${q(r.make)}, ${q(r.model)}, ${q(r.generation)}, ${n(r.year_from)}, ${n(r.year_to)}, ${n(r.wheelbase_mm)}, ${n(r.steering_ratio)}, ${q(r.source)});`;

const HEADER = [
  "-- Generated by seed/cars/generate.mjs — do not edit by hand. To change a row,",
  "-- edit seed/cars/list.json or steering.json and regenerate; once this file has",
  "-- been applied remotely, put additions in a new migration (`--append`) rather",
  "-- than here, since wrangler never re-runs an applied one. Rows are never",
  "-- deleted: a vehicle may reference any id ever issued.",
];

// The full first migration: table, the vehicles link column, every row.
export function renderMigration(rows) {
  return [
    ...HEADER,
    "--",
    "-- The seeded car catalog (#221): one row per *generation* (a Z06 and a",
    "-- Stingray share a wheelbase), carrying the two spec-sheet numbers the",
    "-- balance read-out needs and where each came from. `source` is on the row",
    "-- so a driver who finds a wrong number can see where it came from.",
    "-- steering_ratio is NULL where no single reliable figure exists — a",
    "-- variable-ratio rack the maker only quotes as a range, or a generation",
    "-- nobody has curated yet — and never a guess.",
    "CREATE TABLE car_catalog (",
    "  id INTEGER PRIMARY KEY,",
    "  make TEXT NOT NULL,",
    "  model TEXT NOT NULL,",
    "  generation TEXT,            -- the user-facing disambiguator: C7, ND, 981, F80",
    "  year_from INTEGER NOT NULL,",
    "  year_to INTEGER,            -- NULL = still in production",
    "  wheelbase_mm INTEGER NOT NULL,",
    "  steering_ratio REAL,        -- 16.25 for 16.25:1; NULL where no reliable figure exists",
    "  source TEXT NOT NULL,       -- where both numbers came from, one line",
    "  UNIQUE(make, model, generation)",
    ");",
    "",
    "-- Identity, not ownership — the same role tracks.catalog_id plays. The",
    "-- catalog pre-fills vehicles.wheelbase_mm / steering_ratio at pick time and",
    "-- is never consulted again for that row.",
    "ALTER TABLE vehicles ADD COLUMN catalog_id INTEGER REFERENCES car_catalog(id);",
    "",
    ...rows.map(renderInsert),
    "",
  ].join("\n");
}

// An additions-only migration for generations no committed catalog migration
// already inserts.
export function renderAppend(rows, existingKeys) {
  const fresh = rows.filter((r) => !existingKeys.has(rowKey(r)));
  return [...HEADER, "", ...fresh.map(renderInsert), ""].join("\n");
}

// Every catalog migration in migrations/ (the first one and any --append
// ones), so a staleness check can see the union of what is committed.
export function committedCatalogSql(migrationsDir = MIGRATIONS_DIR) {
  return readdirSync(migrationsDir)
    .filter((f) => /_car_catalog/.test(f) && f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(migrationsDir, f), "utf8"));
}

// The generation keys a set of migration texts inserts, read back from the
// INSERT lines this script wrote.
export function keysInSql(texts) {
  const keys = new Set();
  const re = /^INSERT INTO car_catalog \(make, model, generation[^)]*\) VALUES \('((?:[^']|'')*)', '((?:[^']|'')*)', (NULL|'(?:[^']|'')*')/gm;
  for (const text of texts) {
    for (const m of text.matchAll(re)) {
      const un = (s) => s.replace(/''/g, "'");
      const gen = m[3] === "NULL" ? "" : un(m[3].slice(1, -1));
      keys.add(`${un(m[1])}|${un(m[2])}|${gen}`);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(argv) {
  const list = readJson("list.json");
  const steering = readJson("steering.json");
  const refresh = argv.includes("--refresh");
  const appendAt = argv.indexOf("--append");
  const outPath = appendAt >= 0 ? resolve(argv[appendAt + 1] ?? "") : DEFAULT_MIGRATION;
  if (appendAt >= 0 && !argv[appendAt + 1]) throw new Error("--append needs the new migration's path");

  const snapshotPath = join(dir, "wikidata.json");
  let wikidata = existsSync(snapshotPath) ? readJson("wikidata.json") : {};
  const ids = [...new Set(list.map((e) => e.wikidata).filter(Boolean))];
  if (refresh) {
    wikidata = Object.fromEntries(
      Object.entries(await fetchWikidata(ids)).sort(([a], [b]) => a.localeCompare(b))
    );
    writeFileSync(snapshotPath, JSON.stringify(wikidata, null, 2) + "\n");
    console.log(`Refreshed ${snapshotPath}: ${ids.length} items`);
  }

  const rows = buildRows(list, steering, wikidata);
  if (appendAt >= 0) {
    const existing = keysInSql(committedCatalogSql());
    writeFileSync(outPath, renderAppend(rows, existing));
    console.log(`Wrote ${outPath}: ${rows.length - [...existing].filter((k) => rows.some((r) => rowKey(r) === k)).length} new rows`);
  } else {
    writeFileSync(outPath, renderMigration(rows));
    console.log(`Wrote ${outPath}: ${rows.length} rows, ${rows.filter((r) => r.steering_ratio != null).length} with a steering ratio`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
