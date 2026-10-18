import type { GridData, GridHour, GridRowSource, Range, SourcesConfig } from "./types.ts";
import {
  emissionFactorBasis,
  emissionFactors,
  note,
  useEntry,
  weightedMeanRange,
  type ProvenanceCollector,
} from "./config.ts";

/**
 * Grid carbon intensity for PJM (plan section 9.2).
 *
 * Average intensity, not marginal. That is a known simplification and the pitch
 * has to own it: average is what the free hourly fuel-mix data supports, and
 * marginal emissions are the honest "next step" answer when a judge with an
 * energy background asks.
 *
 * This module is pure. The network call lives in scripts/fetch_grid.ts so the
 * app can always run from cache, which is what keeps the demo alive on bad
 * conference wifi.
 */

/**
 * EIA fuel-type codes seen in the hourly feed, mapped to our factor keys.
 *
 * Checked on 2026-10-18 against documentation only; no live call has been made
 * (no API key). The eight legacy EIA-930 codes below - COL, NG, OIL, NUC, WND,
 * SUN, WAT, OTH - are the ones third-party clients of this exact route show in
 * their example rows. They are NOT confirmed against a real response.
 *
 * Still open, and the reason scripts/fetch_grid.ts prints every code it saw:
 * EIA-930 gained new energy-source categories in 2025 (battery storage,
 * geothermal, pumped storage split out from hydro, wind and solar with and
 * without integrated storage, other and unknown storage). Their API codes are
 * not documented anywhere reachable without a key, so they are deliberately
 * NOT guessed here. Any code missing from this map lands in the wide "OTH"
 * band, which quietly widens every number downstream - so a run that reports
 * unrecognised codes means this map needs updating before any figure from it
 * is shown to anyone.
 */
const FUEL_CODE_MAP: Record<string, string> = {
  COL: "COL",
  NG: "NG",
  OIL: "OIL",
  // Not an EIA code we have seen; kept as a defensive alias for petroleum.
  PET: "OIL",
  NUC: "NUC",
  WND: "WND",
  SUN: "SUN",
  WAT: "WAT",
  // Pumped storage and "other" both land in the deliberately wide OTH band.
  PS: "OTH",
  OTH: "OTH",
};

export function mapFuelCode(code: string): string {
  return FUEL_CODE_MAP[code.toUpperCase()] ?? "OTH";
}

/**
 * Fuel mix (MWh by fuel) -> carbon intensity.
 * intensity = sum(generation_f x factor_f) / sum(generation_f)
 */
export function fuelMixToIntensity(
  mixMwh: Record<string, number>,
  sources: SourcesConfig,
  c: ProvenanceCollector,
): Range {
  const factors = emissionFactors(sources);
  const pairs: { value: Range; weight: number }[] = [];

  for (const [rawCode, mwh] of Object.entries(mixMwh)) {
    if (!Number.isFinite(mwh) || mwh <= 0) continue;
    const key = mapFuelCode(rawCode);
    const entry = factors[key];
    if (!entry) continue;
    pairs.push({ value: useEntry(entry, `EF.${key}`, c), weight: mwh });
  }

  if (pairs.length === 0) {
    return useEntry(sources.grid_fallback, "grid_fallback", c);
  }

  note(c, `Carbon intensity is a generation-weighted average of the fuel mix (${emissionFactorBasis(sources)} factors).`);
  note(c, "Average intensity, not marginal. Marginal emissions would be more precise and are the next step.");
  return weightedMeanRange(pairs, "gCO2/kWh");
}

export interface IntensityLookup {
  intensity: Range;
  source: GridRowSource;
  hour: string | null;
  note: string;
}

/** Nearest cached hour to `timestamp`, or the labelled fallback. */
export function intensityForHour(
  grid: GridData | null,
  timestamp: string | Date,
  sources: SourcesConfig,
  c: ProvenanceCollector,
): IntensityLookup {
  const target = typeof timestamp === "string" ? new Date(timestamp) : timestamp;

  if (grid && grid.hours.length > 0 && !Number.isNaN(target.getTime())) {
    let best: GridHour | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const h of grid.hours) {
      const d = Math.abs(new Date(h.hour).getTime() - target.getTime());
      if (d < bestDistance) {
        bestDistance = d;
        best = h;
      }
    }
    // Beyond a day away the cached hour says nothing useful about this request.
    const withinADay = bestDistance <= 24 * 60 * 60 * 1000;
    if (best && withinADay && best.source !== "fallback") {
      return {
        intensity: best.intensity_gco2_per_kwh,
        source: best.source,
        hour: best.hour,
        note:
          best.source === "eia"
            ? `Cached PJM data for ${best.hour}, from a live API call at ${grid.fetched_at ?? "an unrecorded time"}.`
            : `Seeded demo value for ${best.hour}. Not from the EIA API and not a real measurement.`,
      };
    }
  }

  const fallback = useEntry(sources.grid_fallback, "grid_fallback", c);
  note(c, "Grid intensity is a fallback value, not live data.");
  return {
    intensity: fallback,
    source: "fallback",
    hour: null,
    note: "Fallback value, not live. No cached hour close enough to this timestamp.",
  };
}

export function emptyGrid(region = "PJM"): GridData {
  return {
    region,
    fetched_at: null,
    hours: [],
    from_live_api: false,
    note: "No grid data loaded. Run `npm run grid` after setting EIA_API_KEY, and verify the endpoint against the official docs.",
  };
}

/** Narrow unknown JSON into GridData without trusting its shape. */
export function parseGridData(raw: unknown): GridData {
  if (typeof raw !== "object" || raw === null) return emptyGrid();
  const o = raw as Record<string, unknown>;
  const hoursRaw = Array.isArray(o["hours"]) ? (o["hours"] as unknown[]) : [];
  const hours: GridHour[] = [];

  for (const h of hoursRaw) {
    if (typeof h !== "object" || h === null) continue;
    const e = h as Record<string, unknown>;
    const intensity = e["intensity_gco2_per_kwh"];
    if (typeof e["hour"] !== "string" || typeof intensity !== "object" || intensity === null) continue;
    const i = intensity as Record<string, unknown>;
    if (typeof i["low"] !== "number" || typeof i["high"] !== "number") continue;
    // Unknown values degrade to "fallback", never up to "eia": a row has to
    // say it came from the API to be treated as if it did.
    const rawSource = e["source"];
    const source: GridRowSource =
      rawSource === "eia" ? "eia" : rawSource === "seeded" ? "seeded" : "fallback";
    hours.push({
      hour: e["hour"],
      intensity_gco2_per_kwh: { low: i["low"], high: i["high"], unit: "gCO2/kWh" },
      source,
      ...(typeof e["fuel_mix_mwh"] === "object" && e["fuel_mix_mwh"] !== null
        ? { fuel_mix_mwh: e["fuel_mix_mwh"] as Record<string, number> }
        : {}),
    });
  }

  return {
    region: typeof o["region"] === "string" ? o["region"] : "PJM",
    fetched_at: typeof o["fetched_at"] === "string" ? o["fetched_at"] : null,
    hours,
    from_live_api: o["from_live_api"] === true,
    note: typeof o["note"] === "string" ? o["note"] : "",
  };
}

/** Cleanest and dirtiest hourly rows. Used by the roadmap scheduler pitch. */
export function cleanestHour(grid: GridData): GridHour | null {
  const rows = grid.hours.filter((h) => h.source !== "fallback");
  if (rows.length === 0) return null;
  return rows.reduce((best, h) =>
    midpoint(h.intensity_gco2_per_kwh) < midpoint(best.intensity_gco2_per_kwh) ? h : best,
  );
}

export function dirtiestHour(grid: GridData): GridHour | null {
  const rows = grid.hours.filter((h) => h.source !== "fallback");
  if (rows.length === 0) return null;
  return rows.reduce((worst, h) =>
    midpoint(h.intensity_gco2_per_kwh) > midpoint(worst.intensity_gco2_per_kwh) ? h : worst,
  );
}

export function midpoint(r: Range): number {
  return (r.low + r.high) / 2;
}
