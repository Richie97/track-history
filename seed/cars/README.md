# The car catalog seed

`car_catalog` (migration `0024_car_catalog.sql`) is the seeded list of car
*generations* the vehicle form can pick from, each carrying the two spec-sheet
numbers the balance read-out needs — `wheelbase_mm` and `steering_ratio` — and
a `source` line saying where both came from. The migration is **generated**;
nothing in it is typed by hand, because hand-typing a table of numbers is how
a wrong one gets in.

```sh
node seed/cars/generate.mjs              # rewrite migrations/0024_car_catalog.sql
node seed/cars/generate.mjs --refresh    # re-pull wikidata.json first (network)
node seed/cars/generate.mjs --append migrations/00NN_car_catalog_more.sql
```

Three inputs:

- **`list.json`** — the generations. Deliberately short and track-day-shaped;
  a car that isn't here is typed by hand in the vehicle form, exactly as
  before. Each entry names `make` / `model` / `generation` (the user-facing
  disambiguator: "2017 Corvette" is only ambiguous across generations, and
  both numbers are constant within one, so the catalog is per generation, not
  per trim — a Z06 and a Stingray share a wheelbase; a trim that genuinely
  differs is its own row) and `years` (`[from, to]`, `to` null while still in
  production). Its wheelbase is either a `wikidata` item id (property P3039)
  or, where Wikidata has nothing usable, a cited manufacturer figure:
  `"wheelbase": { "mm": 2700, "source": "…" }` or `{ "in": 90.9, "source": "…" }`.
  The generator refuses an entry with neither, and a cited figure wins over
  Wikidata so a known-bad Wikidata value can be overridden without touching
  the snapshot.
- **`steering.json`** — the hand-curated half, keyed `make|model|generation`.
  A `ratio` needs a `source` (press kit, spec sheet URL) or the generator
  refuses it. A rack the manufacturer only quotes as a *range* (variable-ratio
  steering — most Porsches, the Golf GTI) gets `ratio: null` with a `note`
  saying so: a single number for one of those would be a guess, and a guess
  is the one thing this table must never hold. A generation with no entry gets
  a null ratio marked "not curated".
- **`wikidata.json`** — the committed snapshot of what Wikidata answered for
  every item in the list, so the migration regenerates byte-identically
  offline and a changed figure shows up as a review diff rather than a silent
  rewrite. `--refresh` rebuilds it. Two different P3039 values on one item
  (the Subaru BRZ item carries both generations') count as absent.

Once `0024` has been applied to the remote database, wrangler will never run
it again, so **additions go in a new migration**: edit the inputs and run
`--append` with the new file's path, which emits `INSERT`s only for
generations no committed catalog migration already holds. Rows are never
deleted (a vehicle may reference any id ever issued); a wrong number is fixed
with an `UPDATE` in a new migration and the input files corrected to match.

`test/unit/car-catalog.test.ts` pins the rules: every generated wheelbase is
inside the server's validation range (`WHEELBASE_MM_RANGE` in
`src/lib/validate.ts`), every ratio inside its range and cited, and the
committed migrations carry exactly the rows the inputs describe — so an edit
to `list.json` without a regenerate fails CI.
