import type { Config, Estimate, GridRowSource, Range, ResourceSet, UsageEvent } from "./types.ts";
import {
  addRanges,
  multiplyRanges,
  newCollector,
  note,
  outputEnergyPerToken,
  scaleRange,
  useEntry,
  zeroRange,
  type ProvenanceCollector,
} from "./config.ts";
import { outputTokens } from "./tokens.ts";

/**
 * Resource feedback (plan sections 5.1 and 8.1).
 *
 *   energy_Wh = (output + reasoning) x e_out(class)
 *             + input x e_in  + cache_write x e_cache_write  + cache_read x e_cache_read
 *   CO2_g     = energy_Wh / 1000 x grid_intensity_gCO2_per_kWh
 *   water_mL  = energy_Wh / 1000 x water_per_kWh
 *   cost      = output tokens x the user's own price per token
 *
 * e_in, e_cache_write and e_cache_read default to 0 in config: that is the
 * output-centred model from plan section 6.2, and it is a modelling choice, not
 * a measurement. The assumption is recorded so the UI can say so on screen.
 */

export interface EstimateOptions {
  /** Grid carbon intensity for the hour of the event. Falls back to config. */
  gridIntensity?: Range;
  gridSource?: GridRowSource;
  /** The user's own price per output token, from settings. 0 when unset. */
  pricePerOutputToken?: number;
  /** Wasted output tokens from analyze(). Drives the `wasted` block. */
  wastedOutputTokens?: number;
}

export function estimate(event: UsageEvent, config: Config, opts: EstimateOptions = {}): Estimate {
  const c = newCollector();
  const s = config.sources;

  const eOut = outputEnergyPerToken(s, event.model_class, c);
  const eIn = useEntry(s.e_in, "e_in", c);
  const eCacheWrite = useEntry(s.e_cache_write, "e_cache_write", c);
  const eCacheRead = useEntry(s.e_cache_read, "e_cache_read", c);
  const waterPerKwh = useEntry(s.WI, "WI", c);

  let gridSource: GridRowSource = opts.gridSource ?? "fallback";
  let intensity: Range;
  if (opts.gridIntensity) {
    intensity = opts.gridIntensity;
    if (gridSource === "fallback") {
      note(c, "Grid intensity is a fallback value, not live data.");
    } else if (gridSource === "seeded") {
      note(c, "Grid intensity is a seeded demo value, not from the EIA API.");
    }
  } else {
    intensity = useEntry(s.grid_fallback, "grid_fallback", c);
    gridSource = "fallback";
    note(c, "Grid intensity is a fallback value, not live data.");
  }

  const price = opts.pricePerOutputToken ?? 0;
  if (price === 0) {
    note(c, "Cost shows as zero until you enter your own price per output token in settings.");
  }

  if (eIn.low === 0 && eIn.high === 0) {
    note(
      c,
      "Input tokens are counted as zero energy. That is this model's deliberate output-centred assumption, not a measurement.",
    );
  }
  if (eCacheRead.low === 0 && eCacheRead.high === 0) {
    note(c, "Cached input reads are counted as near-zero energy.");
  }
  if (event.token_source === "estimated") {
    note(c, "Token counts are estimated from the text, not read from a usage field.");
  }
  if (event.tokens.reasoning === 0 && event.surface === "web") {
    note(
      c,
      "Hidden reasoning tokens are not visible in web chat, so output here is probably undercounted.",
    );
  }

  const out = outputTokens(event.tokens);

  const total = resourcesFor(out, event.tokens, {
    eOut,
    eIn,
    eCacheWrite,
    eCacheRead,
    intensity,
    waterPerKwh,
    price,
  });

  // Waste is attributed to output only. We can say which output tokens were
  // wasted; we cannot say which input tokens were, so claiming any would be
  // inventing a number.
  const wastedOut = opts.wastedOutputTokens ?? 0;
  const wasted = resourcesFor(
    wastedOut,
    { input: 0, cache_write: 0, cache_read: 0 },
    { eOut, eIn, eCacheWrite, eCacheRead, intensity, waterPerKwh, price },
  );

  return {
    ...total,
    wasted,
    provenance: {
      unverified: [...c.unverified].sort(),
      assumptions: c.assumptions,
      gridSource,
    },
  };
}

interface Factors {
  eOut: Range;
  eIn: Range;
  eCacheWrite: Range;
  eCacheRead: Range;
  intensity: Range;
  waterPerKwh: Range;
  price: number;
}

function resourcesFor(
  outTokens: number,
  other: { input: number; cache_write: number; cache_read: number },
  f: Factors,
): ResourceSet {
  let energyWh = scaleRange(f.eOut, outTokens, "Wh");
  energyWh = addRanges(energyWh, scaleRange(f.eIn, other.input, "Wh"));
  energyWh = addRanges(energyWh, scaleRange(f.eCacheWrite, other.cache_write, "Wh"));
  energyWh = addRanges(energyWh, scaleRange(f.eCacheRead, other.cache_read, "Wh"));

  const energyKwh = scaleRange(energyWh, 1 / 1000, "kWh");
  const co2g = multiplyRanges(energyKwh, f.intensity, "g");
  const waterMl = multiplyRanges(energyKwh, f.waterPerKwh, "mL");
  const cost =
    f.price === 0 ? zeroRange("USD") : scaleRange({ low: 1, high: 1, unit: "x" }, outTokens * f.price, "USD");

  return { energyWh, waterMl, co2g, cost };
}

/**
 * Energy difference between two model classes per 1000 output tokens.
 * Expressed per 1000 tokens so no output length has to be invented, which is
 * what the model suggestion needs (plan section 5.5).
 */
export function energyDeltaPer1kOutput(
  config: Config,
  from: UsageEvent["model_class"],
  to: UsageEvent["model_class"],
): { range: Range; collector: ProvenanceCollector } {
  const c = newCollector();
  const a = outputEnergyPerToken(config.sources, from, c);
  const b = outputEnergyPerToken(config.sources, to, c);
  const range: Range = {
    low: Math.min(a.low * 1000 - b.high * 1000, a.high * 1000 - b.low * 1000),
    high: Math.max(a.low * 1000 - b.high * 1000, a.high * 1000 - b.low * 1000),
    unit: "Wh per 1k output tokens",
  };
  return { range, collector: c };
}
