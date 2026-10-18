/**
 * Fetches real hourly PJM fuel-mix data from the EIA API and caches it to
 * data/grid_pjm.json (plan section 9.2, demo-core item D8).
 *
 * Run: EIA_API_KEY=your_key npm run grid
 * Get a free key at https://www.eia.gov/opendata/
 *
 * ===========================================================================
 * EVERYTHING ABOUT THIS ENDPOINT IS UNVERIFIED. VERIFY IT IN HOUR 0-1.
 * ===========================================================================
 * The plan's risk table calls out AI-invented API details specifically, and
 * this file is where that risk lives. The route, the parameter names, the facet
 * name, the fuel-type codes and the field names below were written from memory
 * and have NOT been checked against a real response.
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

// --- VERIFY THIS BLOCK ------------------------------------------------------
const EIA_BASE = "https://api.eia.gov/v2/electricity/rto/fuel-type-data/data/";
const RESPONDENT = "PJM";
const DAYS_BACK = 30;
// ---------------------------------------------------------------------------

const apiKey = process.env["EIA_API_KEY"];
if (!apiKey) {
  console.error(
    [
      "EIA_API_KEY is not set.",
      "",
      "  1. Get a free key: https://www.eia.gov/opendata/",
      "  2. EIA_API_KEY=your_key npm run grid",
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

const url = new URL(EIA_BASE);
url.searchParams.set("api_key", apiKey);
url.searchParams.set("frequency", "hourly");
url.searchParams.append("data[]", "value");
url.searchParams.append("facets[respondent][]", RESPONDENT);
url.searchParams.set("start", toEiaHour(start));
url.searchParams.set("end", toEiaHour(end));
url.searchParams.append("sort[0][column]", "period");
url.searchParams.append("sort[0][direction]", "asc");
url.searchParams.set("length", "5000");

console.log(`GET ${EIA_BASE}`);
console.log(`  respondent=${RESPONDENT} frequency=hourly ${toEiaHour(start)} -> ${toEiaHour(end)}`);
console.log("  (api_key redacted)\n");

const res = await fetch(url);
if (!res.ok) {
  const body = await res.text().catch(() => "<no body>");
  console.error(`EIA returned HTTP ${res.status}.`);
  console.error(body.slice(0, 1200));
  console.error(
    "\nCheck the route, the parameter names and the facet name against the current docs:",
  );
  console.error("  https://www.eia.gov/opendata/browser/electricity/rto/fuel-type-data");
  process.exit(1);
}

const payload: unknown = await res.json();

// --- VERIFY THIS BLOCK: response shape -------------------------------------
const rows = extractRows(payload);
if (rows.length === 0) {
  console.error("Parsed zero rows. The response shape is probably not what this script expects.");
  console.error("First 1500 characters of what came back:\n");
  console.error(JSON.stringify(payload).slice(0, 1500));
  process.exit(1);
}

console.log(`Parsed ${rows.length} rows. First row exactly as received:`);
console.log(JSON.stringify(rows[0], null, 2));
console.log("\n^ Check these field names against the ones this script reads:");
console.log('   period, fueltype, value\n');

// Group by hour, summing generation per fuel.
const byHour = new Map<string, Record<string, number>>();
const codesSeen = new Set<string>();

for (const row of rows) {
  const period = row["period"];
  const fuel = row["fueltype"] ?? row["fuelType"] ?? row["type-name"];
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
console.log("  [ ] Emissions factor source chosen; lifecycle or direct stated");

// --- helpers ----------------------------------------------------------------

function toEiaHour(d: Date): string {
  // EIA hourly periods look like 2026-10-18T14. VERIFY this format.
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
