/**
 * Fetches real hourly PJM fuel-mix data from the EIA API and caches it to
 * data/grid_pjm.json (plan section 9.2, demo-core item D8).
 *
 * Run: EIA_API_KEY=your_key npm run grid
 * Get a free key at https://www.eia.gov/opendata/
 *
 * ===========================================================================
 * CHECKED AGAINST THE DOCS ON 2026-10-18. NEVER RUN AGAINST A REAL RESPONSE.
 * ===========================================================================
 * What is now confirmed from documentation (no API key was available, so no
 * live call has been made):
 *   - Route shape `https://api.eia.gov/v2/<route>/data`, api_key in the URL
 *     (not a header), `frequency`, `data[]`, `facets[<id>][]`, `start`/`end`,
 *     `sort[0][column]`/`sort[0][direction]`, `offset`, `length`:
 *     https://www.eia.gov/opendata/documentation.php
 *   - JSON responses return AT MOST 5000 rows per request, `response.total`
 *     reports the full match count, and hitting the cap comes back with a
 *     `warning`. 30 days of hourly PJM data is ~24 x 30 x (number of fuel
 *     types) rows, which is well over 5000, so this script now pages.
 *   - Row fields for this dataset are `period`, `respondent`,
 *     `respondent-name`, `fueltype`, `type-name`, `value`, `value-units`
 *     (third-party clients that call this exact route: gridstatus, and the
 *     CRAN EIAapi package README). `type-name` is a human-readable label such
 *     as "Natural gas", NOT a code, so it must not be read as a fuel code.
 *
 * What is still UNVERIFIED:
 *   - Everything above against an actual response body, including the hourly
 *     `period` format and whether `facets[respondent][]=PJM` is the right
 *     facet value.
 *   - The fuel-type codes. EIA-930 gained new energy-source categories in
 *     2025 (battery storage, geothermal, pumped storage split out from hydro,
 *     wind/solar with and without integrated storage, other/unknown storage),
 *     and their API codes are not documented anywhere this script's author
 *     could reach. Any code missing from FUEL_CODE_MAP in
 *     packages/core/src/grid.ts lands in the deliberately wide "OTH" band and
 *     quietly widens every number downstream, so read the report this script
 *     prints at the end before trusting a single figure.
 *
 * So this script is built to verify rather than to assume:
 *   - it prints the raw first row it receives, so field names can be eyeballed;
 *   - it prints every distinct fuel code it saw, so they can be checked against
 *     config/sources.json (anything unrecognised silently lands in the wide
 *     "OTH" band, which would quietly widen every number downstream);
 *   - it fails loudly rather than writing a half-parsed file.
 *
 * If the shape has changed, fix the two marked spots below. The rest of the
 * product reads the cached file and does not care how it was produced.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { newCollector } from "../packages/core/src/config.ts";
import { fuelMixToIntensity, mapFuelCode } from "../packages/core/src/grid.ts";
import type { GridData, GridHour, SourcesConfig } from "../packages/core/src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// --- Route and parameters (checked against the docs, not against a response) -
const EIA_BASE = "https://api.eia.gov/v2/electricity/rto/fuel-type-data/data";
const RESPONDENT = "PJM";
const DAYS_BACK = 30;
// The documented JSON cap is 5000 rows per request, so pages are requested
// until `response.total` is covered.
const PAGE_SIZE = 5000;
const MAX_PAGES = 20;
// ---------------------------------------------------------------------------

const apiKey = process.env["EIA_API_KEY"];
if (!apiKey) {
  console.error(
    [
      "EIA_API_KEY is not set.",
      "",
      "  1. Register for a free key: https://www.eia.gov/opendata/register.php",
      "     It arrives by email, usually within a minute.",
      "  2. Paste it into the .env file in the project root:  EIA_API_KEY=your_key",
      "  3. npm run grid",
      "",
      "(.env is git-ignored, so the key stays on this machine. No .env? Copy",
      " .env.example to .env. A one-off also works: EIA_API_KEY=key npm run grid)",
      "",
      "Until then the app runs on data/grid_pjm.json, which is seeded demo data.",
      "Every figure derived from it is labelled as seeded, so the demo still works",
      "honestly without a key - it just is not live.",
    ].join("\n"),
  );
  process.exit(1);
}

const end = new Date();
const start = new Date(end.getTime() - DAYS_BACK * 24 * 60 * 60 * 1000);

function pageUrl(offset: number): URL {
  const url = new URL(EIA_BASE);
  url.searchParams.set("api_key", apiKey as string);
  url.searchParams.set("frequency", "hourly");
  url.searchParams.append("data[]", "value");
  url.searchParams.append("facets[respondent][]", RESPONDENT);
  url.searchParams.set("start", toEiaHour(start));
  url.searchParams.set("end", toEiaHour(end));
  url.searchParams.append("sort[0][column]", "period");
  url.searchParams.append("sort[0][direction]", "asc");
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("length", String(PAGE_SIZE));
  return url;
}

console.log(`GET ${EIA_BASE}`);
console.log(`  respondent=${RESPONDENT} frequency=hourly ${toEiaHour(start)} -> ${toEiaHour(end)}`);
console.log(`  paging ${PAGE_SIZE} rows at a time (api_key redacted)\n`);

const rows: Record<string, unknown>[] = [];
let total: number | null = null;

for (let page = 0; page < MAX_PAGES; page++) {
  const offset = page * PAGE_SIZE;
  const res = await fetch(pageUrl(offset));
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    console.error(`EIA returned HTTP ${res.status} for offset ${offset}.`);
    console.error(body.slice(0, 1200));
    console.error(
      "\nCheck the route, the parameter names and the facet name against the current docs:",
    );
    console.error("  https://www.eia.gov/opendata/browser/electricity/rto/fuel-type-data");
    console.error("  https://www.eia.gov/opendata/documentation.php");
    process.exit(1);
  }

  const payload: unknown = await res.json();

  // --- Response shape (documented, never seen) ------------------------------
  // Documented as { response: { total, dateFormat, frequency, data: [...] } },
  // with a `warning` field when the row cap is hit and `error` / `code` on a
  // bad request. Values come back as STRINGS, which is why `value` is parsed
  // rather than trusted as a number.
  const warning = readString(payload, "warning");
  if (warning) console.log(`EIA warning: ${warning}`);
  const error = readString(payload, "error");
  if (error) {
    console.error(`EIA error: ${error}`);
    process.exit(1);
  }
  if (total === null) {
    total = readTotal(payload);
    if (total !== null) console.log(`EIA reports ${total} matching rows.`);
  }

  const pageRows = extractRows(payload);
  if (page === 0) {
    if (pageRows.length === 0) {
      console.error("Parsed zero rows. The response shape is probably not what this script expects.");
      console.error("First 1500 characters of what came back:\n");
      console.error(JSON.stringify(payload).slice(0, 1500));
      process.exit(1);
    }
    console.log(`First row exactly as received:`);
    console.log(JSON.stringify(pageRows[0], null, 2));
    console.log("\n^ Check these field names against the ones this script reads:");
    console.log("   period, fueltype, value");
    console.log("   (`type-name` is a human label like \"Natural gas\", not a code)\n");
  }

  rows.push(...pageRows);
  if (pageRows.length < PAGE_SIZE) break;
  if (total !== null && rows.length >= total) break;
  if (page === MAX_PAGES - 1) {
    console.log(
      `Stopped after ${MAX_PAGES} pages with ${rows.length} rows. Raise MAX_PAGES or shorten DAYS_BACK.`,
    );
  }
}

console.log(`Parsed ${rows.length} rows in total.`);

// Group by hour, summing generation per fuel.
const byHour = new Map<string, Record<string, number>>();
const codesSeen = new Set<string>();

for (const row of rows) {
  const period = row["period"];
  // `fueltype` only. `type-name` is a display label, so falling back to it
  // would feed "Natural gas" into mapFuelCode and silently land in "OTH".
  const fuel = row["fueltype"];
  const value = row["value"];
  if (typeof period !== "string" || typeof fuel !== "string") continue;

  const mwh = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(mwh)) continue;

  codesSeen.add(fuel);
  const hour = normalizeHour(period);
  const bucket = byHour.get(hour) ?? {};
  bucket[fuel] = (bucket[fuel] ?? 0) + mwh;
  byHour.set(hour, bucket);
}

const sources = (await loadJson(join(root, "config", "sources.json"))) as SourcesConfig;
const collector = newCollector();

const hours: GridHour[] = [...byHour.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([hour, mix]) => ({
    hour,
    intensity_gco2_per_kwh: fuelMixToIntensity(mix, sources, collector),
    source: "eia" as const,
    fuel_mix_mwh: mix,
  }));

const grid: GridData = {
  region: RESPONDENT,
  fetched_at: new Date().toISOString(),
  hours,
  from_live_api: true,
  note:
    `Live EIA hourly fuel-type data for ${RESPONDENT}, converted to carbon intensity with the ` +
    "emission factors in config/sources.json. Average intensity, not marginal.",
};

mkdirSync(join(root, "data"), { recursive: true });
writeFileSync(join(root, "data", "grid_pjm.json"), `${JSON.stringify(grid, null, 2)}\n`, "utf8");

console.log(`Wrote data/grid_pjm.json with ${hours.length} hours.`);

// --- verification report ----------------------------------------------------

const known = [...codesSeen].filter((c) => mapFuelCode(c) !== "OTH" || c.toUpperCase() === "OTH");
const unknown = [...codesSeen].filter((c) => mapFuelCode(c) === "OTH" && c.toUpperCase() !== "OTH");

console.log(`\nFuel codes received: ${[...codesSeen].sort().join(", ")}`);
console.log(`  recognised: ${known.sort().join(", ") || "(none)"}`);
if (unknown.length > 0) {
  console.log(`  NOT RECOGNISED: ${unknown.sort().join(", ")}`);
  console.log("  These fell into the wide 'OTH' band, which widens every number downstream.");
  console.log("  Add them to FUEL_CODE_MAP in packages/core/src/grid.ts and to EF in config/sources.json.");
}

if (collector.unverified.size > 0) {
  console.log(`\nStill unverified in config/sources.json: ${[...collector.unverified].sort().join(", ")}`);
  console.log("The intensities above inherit that uncertainty. The UI labels them.");
}

console.log("\nTick off in the plan's section 20 checklist:");
console.log("  [ ] Real EIA API call made; endpoint and fields recorded");
console.log("      (route and parameters checked against the docs on 2026-10-18,");
console.log("       but never run: this line stays unticked until it is)");
console.log("  [x] Emissions factor source chosen; lifecycle or direct stated");
console.log("      (EPA eGRID2023 rev2, direct combustion - see config/sources.json)");

// --- helpers ----------------------------------------------------------------

function toEiaHour(d: Date): string {
  // EIA hourly periods look like 2026-10-18T14. The docs describe start/end as
  // date bounds in the dataset's own period format, and `response.dateFormat`
  // in the reply states that format - print it and check if a call returns
  // nothing.
  return `${d.toISOString().slice(0, 13)}`;
}

function normalizeHour(period: string): string {
  // Accepts "2026-10-18T14", "2026-10-18T14:00:00Z" and "2026-10-18 14".
  const cleaned = period.replace(" ", "T");
  const base = cleaned.length <= 13 ? `${cleaned}:00:00Z` : cleaned;
  const d = new Date(base);
  if (Number.isNaN(d.getTime())) return period;
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function readString(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const o = payload as Record<string, unknown>;
  const direct = o[key];
  if (typeof direct === "string") return direct;
  const response = o["response"];
  if (typeof response === "object" && response !== null) {
    const nested = (response as Record<string, unknown>)[key];
    if (typeof nested === "string") return nested;
  }
  return null;
}

/** `response.total` is documented as a string, so it is parsed, not cast. */
function readTotal(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const o = payload as Record<string, unknown>;
  const response = o["response"];
  const raw =
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>)["total"]
      : o["total"];
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) ? n : null;
}

function extractRows(payload: unknown): Record<string, unknown>[] {
  if (typeof payload !== "object" || payload === null) return [];
  const o = payload as Record<string, unknown>;

  // Documented shape: { response: { data: [...] } }
  const response = o["response"];
  if (typeof response === "object" && response !== null) {
    const data = (response as Record<string, unknown>)["data"];
    if (Array.isArray(data)) return data.filter(isRow);
  }
  // Tolerate a flatter shape rather than failing on a cosmetic change.
  if (Array.isArray(o["data"])) return (o["data"] as unknown[]).filter(isRow);
  return [];
}

function isRow(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

async function loadJson(path: string): Promise<unknown> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8"));
}
