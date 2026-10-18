import type {
  Baseline,
  CardData,
  Config,
  FlagType,
  GridData,
  GridRowSource,
  ResourceSet,
  UsageEvent,
} from "./types.ts";
import { addRanges, newCollector, zeroRange } from "./config.ts";
import { estimate } from "./estimate.ts";
import { intensityForHour } from "./grid.ts";
import { outputTokens } from "./tokens.ts";

/**
 * Weekly efficiency card (plan section 5.7).
 *
 * This is the growth loop: a small shareable image with an efficiency % and the
 * resources behind it. It only shares scores, never text, which is both the
 * privacy promise and the reason it can be shared at all.
 *
 * The baseline is still an open decision in the plan (section 19 item 5), so
 * both options are implemented and the card reports which one produced the
 * number. Picking one silently would hide the choice from the judges' question
 * "compared to what?".
 */

export const DEFAULT_BASELINE: Baseline = { kind: "first_n", n: 50 };

export interface CardOptions {
  baseline?: Baseline;
  grid?: GridData | null;
  pricePerOutputToken?: number;
  isDemoData?: boolean;
}

export function weeklyCard(events: UsageEvent[], config: Config, opts: CardOptions = {}): CardData {
  const baseline = opts.baseline ?? DEFAULT_BASELINE;
  const isDemoData = opts.isDemoData ?? false;
  const sorted = [...events].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  if (sorted.length === 0) {
    return {
      efficiency: 1,
      baselineEfficiency: null,
      changePoints: null,
      wastedTokens: 0,
      topWasteType: null,
      eventsCounted: 0,
      resources: emptyResources(),
      baseline,
      baselineLabel: describeBaseline(baseline),
      periodStart: null,
      periodEnd: null,
      provenance: { unverified: [], assumptions: ["No events yet."], gridSource: "fallback" },
      isDemoData,
    };
  }

  const { baselineEvents, currentEvents } = splitByBaseline(sorted, baseline);

  const unverified = new Set<string>();
  const assumptions: string[] = [];
  // Report the weakest provenance seen, not the best: a card whose hours were
  // mostly seeded should not describe itself as live because one row was.
  const sourcesSeen = new Set<GridRowSource>();
  let resources = emptyResources();
  let wastedTokens = 0;
  const wasteByType = new Map<FlagType, number>();

  for (const ev of currentEvents) {
    const c = newCollector();
    const lookup = intensityForHour(opts.grid ?? null, ev.timestamp, config.sources, c);
    sourcesSeen.add(lookup.source);

    const wastedForEvent = wastedTokensOf(ev);
    wastedTokens += wastedForEvent;

    const est = estimate(ev, config, {
      gridIntensity: lookup.intensity,
      gridSource: lookup.source,
      ...(opts.pricePerOutputToken !== undefined
        ? { pricePerOutputToken: opts.pricePerOutputToken }
        : {}),
      wastedOutputTokens: wastedForEvent,
    });

    resources = {
      energyWh: addRanges(resources.energyWh, est.wasted.energyWh),
      waterMl: addRanges(resources.waterMl, est.wasted.waterMl),
      co2g: addRanges(resources.co2g, est.wasted.co2g),
      cost: addRanges(resources.cost, est.wasted.cost),
    };

    for (const key of est.provenance.unverified) unverified.add(key);
    for (const a of est.provenance.assumptions) {
      if (!assumptions.includes(a)) assumptions.push(a);
    }
    for (const f of ev.flags) {
      if (f.confidence !== "high") continue;
      wasteByType.set(f.type, (wasteByType.get(f.type) ?? 0) + f.tokens);
    }
  }

  const efficiency = efficiencyOf(currentEvents);
  const baselineEfficiency = baselineEvents.length > 0 ? efficiencyOf(baselineEvents) : null;

  let topWasteType: FlagType | null = null;
  let topWaste = -1;
  for (const [type, tokens] of wasteByType) {
    if (tokens > topWaste) {
      topWaste = tokens;
      topWasteType = type;
    }
  }

  if (baselineEfficiency === null) {
    assumptions.push(
      `Not enough history for a baseline yet (${describeBaseline(baseline)}), so there is no change figure.`,
    );
  }

  return {
    efficiency,
    baselineEfficiency,
    changePoints:
      baselineEfficiency === null ? null : (efficiency - baselineEfficiency) * 100,
    wastedTokens,
    topWasteType,
    eventsCounted: currentEvents.length,
    resources,
    baseline,
    baselineLabel: describeBaseline(baseline),
    periodStart: currentEvents[0]?.timestamp ?? null,
    periodEnd: currentEvents[currentEvents.length - 1]?.timestamp ?? null,
    provenance: { unverified: [...unverified].sort(), assumptions, gridSource: weakestSource(sourcesSeen) },
    isDemoData,
  };
}

/** fallback beats seeded beats eia, so the label never overstates the data. */
function weakestSource(seen: Set<GridRowSource>): GridRowSource {
  if (seen.has("fallback") || seen.size === 0) return "fallback";
  if (seen.has("seeded")) return "seeded";
  return "eia";
}

function splitByBaseline(
  sorted: UsageEvent[],
  baseline: Baseline,
): { baselineEvents: UsageEvent[]; currentEvents: UsageEvent[] } {
  if (baseline.kind === "first_n") {
    if (sorted.length <= baseline.n) return { baselineEvents: [], currentEvents: sorted };
    return {
      baselineEvents: sorted.slice(0, baseline.n),
      currentEvents: sorted.slice(baseline.n),
    };
  }

  const start = new Date(sorted[0]!.timestamp).getTime();
  const cutoff = start + baseline.days * 24 * 60 * 60 * 1000;
  const baselineEvents = sorted.filter((e) => new Date(e.timestamp).getTime() < cutoff);
  const currentEvents = sorted.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
  if (currentEvents.length === 0) return { baselineEvents: [], currentEvents: sorted };
  return { baselineEvents, currentEvents };
}

/** Token-weighted, so one short answer cannot swing the figure. */
export function efficiencyOf(events: UsageEvent[]): number {
  let wasted = 0;
  let total = 0;
  for (const ev of events) {
    wasted += wastedTokensOf(ev);
    total += outputTokens(ev.tokens);
  }
  if (total === 0) return 1;
  return Math.max(0, Math.min(1, 1 - wasted / total));
}

/**
 * Waste for a stored event, from its high-confidence flags only.
 *
 * Stored flags carry per-flag token counts rather than spans we can re-merge,
 * so this caps the sum at the event's output tokens. Without the cap, two
 * detectors that covered the same words would push efficiency below zero.
 */
export function wastedTokensOf(event: UsageEvent): number {
  const sum = event.flags
    .filter((f) => f.confidence === "high")
    .reduce((s, f) => s + f.tokens, 0);
  return Math.min(sum, outputTokens(event.tokens));
}

export function describeBaseline(baseline: Baseline): string {
  return baseline.kind === "first_n"
    ? `your first ${baseline.n} responses`
    : `your first ${baseline.days} days`;
}

function emptyResources(): ResourceSet {
  return {
    energyWh: zeroRange("Wh"),
    waterMl: zeroRange("mL"),
    co2g: zeroRange("g"),
    cost: zeroRange("USD"),
  };
}
