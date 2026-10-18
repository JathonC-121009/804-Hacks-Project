import { test } from "node:test";
import assert from "node:assert/strict";

import { analyze } from "../src/detect.ts";
import { auditConfig, newCollector, UnsourcedValueError, useEntry } from "../src/config.ts";
import { energyDeltaPer1kOutput, estimate } from "../src/estimate.ts";
import { estimateTokens, outputTokens } from "../src/tokens.ts";
import {
  cleanestHour,
  dirtiestHour,
  emptyGrid,
  fuelMixToIntensity,
  intensityForHour,
  mapFuelCode,
  parseGridData,
} from "../src/grid.ts";
import { efficiencyOf, weeklyCard } from "../src/card.ts";
import { runFullAnalysis } from "../src/index.ts";
import type { GridData, UsageEvent } from "../src/types.ts";
import { FIXTURES, testConfig } from "./fixtures.ts";

const config = testConfig();

function eventFrom(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: "evt_test",
    timestamp: "2026-10-18T14:00:00Z",
    surface: "paste",
    tool: "other",
    model: "test",
    model_class: "large",
    tokens: { input: 100, cache_write: 0, cache_read: 0, output: 500, reasoning: 0 },
    token_source: "exact",
    flags: [],
    region: "PJM",
    ...overrides,
  };
}

// --- tokens -----------------------------------------------------------------

test("token estimates return a range, with the midpoint inside it", () => {
  const r = estimateTokens("The quick brown fox jumps over the lazy dog.");
  assert.ok(r.low > 0);
  assert.ok(r.high >= r.low);
  assert.ok(r.tokens >= r.low && r.tokens <= r.high);
});

test("empty text costs nothing", () => {
  assert.deepEqual(estimateTokens("   "), {
    tokens: 0,
    low: 0,
    high: 0,
    method: "words_x_1.3 and chars_div_4",
  });
});

test("reasoning tokens are billed as output", () => {
  const t = { input: 10, cache_write: 0, cache_read: 0, output: 100, reasoning: 400 };
  assert.equal(outputTokens(t), 500);
});

// --- estimate ---------------------------------------------------------------

test("D3: every figure carries a range and a unit", () => {
  const est = estimate(eventFrom(), config);
  for (const [name, r] of Object.entries({
    energyWh: est.energyWh,
    waterMl: est.waterMl,
    co2g: est.co2g,
    cost: est.cost,
  })) {
    assert.ok(r.high >= r.low, `${name}: high must be >= low`);
    assert.ok(r.unit.length > 0, `${name}: missing unit`);
  }
});

test("energy scales linearly with output tokens", () => {
  const a = estimate(eventFrom({ tokens: { input: 0, cache_write: 0, cache_read: 0, output: 100, reasoning: 0 } }), config);
  const b = estimate(eventFrom({ tokens: { input: 0, cache_write: 0, cache_read: 0, output: 200, reasoning: 0 } }), config);
  assert.ok(Math.abs(b.energyWh.low - a.energyWh.low * 2) < 1e-9);
  assert.ok(Math.abs(b.energyWh.high - a.energyWh.high * 2) < 1e-9);
});

test("input and cached tokens add no energy under the output-centred model", () => {
  const withInput = estimate(
    eventFrom({ tokens: { input: 100000, cache_write: 5000, cache_read: 900000, output: 100, reasoning: 0 } }),
    config,
  );
  const outputOnly = estimate(
    eventFrom({ tokens: { input: 0, cache_write: 0, cache_read: 0, output: 100, reasoning: 0 } }),
    config,
  );
  assert.deepEqual(withInput.energyWh, outputOnly.energyWh);
  assert.ok(
    withInput.provenance.assumptions.some((a) => a.includes("output-centred")),
    "the assumption must be stated, not just applied",
  );
});

test("a bigger model class costs more energy for the same output", () => {
  const small = estimate(eventFrom({ model_class: "small" }), config);
  const large = estimate(eventFrom({ model_class: "large" }), config);
  assert.ok(large.energyWh.high > small.energyWh.high);
});

test("cost stays zero, and says why, until the user enters a price", () => {
  const est = estimate(eventFrom(), config);
  assert.deepEqual(est.cost, { low: 0, high: 0, unit: "USD" });
  assert.ok(est.provenance.assumptions.some((a) => a.includes("price per output token")));

  const priced = estimate(eventFrom(), config, { pricePerOutputToken: 0.00001 });
  assert.ok(priced.cost.high > 0);
});

test("wasted resources are a share of the total, never more", () => {
  const est = estimate(eventFrom(), config, { wastedOutputTokens: 125 });
  assert.ok(est.wasted.energyWh.high <= est.energyWh.high);
  assert.ok(est.wasted.energyWh.high > 0);
  assert.ok(est.wasted.co2g.high > 0);
  assert.ok(est.wasted.waterMl.high > 0);
});

test("with no waste, the wasted block is all zeros", () => {
  const est = estimate(eventFrom(), config, { wastedOutputTokens: 0 });
  assert.equal(est.wasted.energyWh.high, 0);
  assert.equal(est.wasted.co2g.high, 0);
});

test("falling back on grid data is recorded as an assumption", () => {
  const est = estimate(eventFrom(), config);
  assert.equal(est.provenance.gridSource, "fallback");
  assert.ok(est.provenance.assumptions.some((a) => a.includes("fallback")));
});

test("web-chat events warn that hidden reasoning is uncounted", () => {
  const est = estimate(eventFrom({ surface: "web" }), config);
  assert.ok(est.provenance.assumptions.some((a) => a.includes("reasoning")));
});

test("estimated token counts are disclosed", () => {
  const est = estimate(eventFrom({ token_source: "estimated" }), config);
  assert.ok(est.provenance.assumptions.some((a) => a.includes("estimated from the text")));
});

// --- config provenance ------------------------------------------------------

test("an unverified source key is reported, not silently used", () => {
  const dirty = testConfig();
  dirty.sources.e_out_large = { ...dirty.sources.e_out_large, verified: false };
  const est = estimate(eventFrom({ model_class: "large" }), dirty);
  assert.ok(est.provenance.unverified.includes("e_out_large"));
});

test("a source with no value yet fails loudly instead of becoming zero", () => {
  const c = newCollector();
  assert.throws(
    () =>
      useEntry(
        { low: null, high: null, unit: "unset", source: "PLACEHOLDER", verified: false },
        "va_dc",
        c,
      ),
    UnsourcedValueError,
  );
});

test("auditConfig lists what still has to be fixed before the pitch", () => {
  const clean = auditConfig(testConfig());
  assert.deepEqual(clean, [], "the test config is fully verified by construction");

  const dirty = testConfig();
  dirty.sources.WI = { ...dirty.sources.WI, verified: false, source: "PLACEHOLDER" };
  dirty.sources.EF = { ...dirty.sources.EF, _basis: "UNDECIDED" };
  const warnings = auditConfig(dirty);
  assert.ok(warnings.some((w) => w.key === "WI"));
  assert.ok(warnings.some((w) => w.key === "EF._basis"));
});

// --- grid -------------------------------------------------------------------

test("fuel mix becomes a generation-weighted intensity", () => {
  const c = newCollector();
  const allCoal = fuelMixToIntensity({ COL: 1000 }, config.sources, c);
  const allWind = fuelMixToIntensity({ WND: 1000 }, config.sources, c);
  const half = fuelMixToIntensity({ COL: 500, WND: 500 }, config.sources, c);

  assert.ok(allCoal.low > allWind.high, "coal must be dirtier than wind");
  assert.ok(half.low > allWind.low && half.high < allCoal.high, "a mix lands between the two");
  assert.ok(c.assumptions.some((a) => a.includes("marginal")), "the average-vs-marginal limit must be stated");
});

test("an empty or unusable fuel mix falls back rather than returning zero", () => {
  const c = newCollector();
  const r = fuelMixToIntensity({}, config.sources, c);
  assert.deepEqual(r, { low: 300, high: 500, unit: "gCO2/kWh" });
  assert.ok(c.unverified.size === 0, "the test config is verified, so nothing should be flagged");
});

test("unknown fuel codes land in the wide 'other' band", () => {
  assert.equal(mapFuelCode("col"), "COL");
  assert.equal(mapFuelCode("PET"), "OIL");
  assert.equal(mapFuelCode("PS"), "OTH");
  assert.equal(mapFuelCode("SOMETHING_NEW"), "OTH");
});

function gridWith(hours: { hour: string; low: number; high: number }[]): GridData {
  return {
    region: "PJM",
    fetched_at: "2026-10-18T15:00:00Z",
    from_live_api: true,
    note: "test",
    hours: hours.map((h) => ({
      hour: h.hour,
      intensity_gco2_per_kwh: { low: h.low, high: h.high, unit: "gCO2/kWh" },
      source: "eia" as const,
    })),
  };
}

test("the nearest cached hour is used when one is close enough", () => {
  const grid = gridWith([
    { hour: "2026-10-18T13:00:00Z", low: 100, high: 150 },
    { hour: "2026-10-18T14:00:00Z", low: 400, high: 450 },
  ]);
  const c = newCollector();
  const r = intensityForHour(grid, "2026-10-18T14:10:00Z", config.sources, c);
  assert.equal(r.source, "eia");
  assert.equal(r.hour, "2026-10-18T14:00:00Z");
  assert.equal(r.intensity.low, 400);
});

test("a cached hour more than a day away is not used", () => {
  const grid = gridWith([{ hour: "2026-01-01T00:00:00Z", low: 100, high: 150 }]);
  const c = newCollector();
  const r = intensityForHour(grid, "2026-10-18T14:00:00Z", config.sources, c);
  assert.equal(r.source, "fallback");
  assert.ok(r.note.includes("Fallback"));
});

test("D8: with no grid data at all, the app still works and says so", () => {
  const c = newCollector();
  const r = intensityForHour(emptyGrid(), "2026-10-18T14:00:00Z", config.sources, c);
  assert.equal(r.source, "fallback");
  assert.equal(r.hour, null);
  assert.ok(c.assumptions.some((a) => a.includes("fallback")));
});

test("seeded grid rows are labelled as seeded, never as live EIA data", () => {
  const base = gridWith([{ hour: "2026-10-18T14:00:00Z", low: 400, high: 450 }]);
  const seeded: GridData = {
    ...base,
    from_live_api: false,
    hours: base.hours.map((h) => ({ ...h, source: "seeded" as const })),
  };
  const c = newCollector();
  const r = intensityForHour(seeded, "2026-10-18T14:00:00Z", config.sources, c);
  assert.equal(r.source, "seeded");
  assert.match(r.note, /Seeded demo value/);
  assert.match(r.note, /[Nn]ot from the EIA API/);
});

test("an unknown source value degrades to fallback rather than up to eia", () => {
  const parsed = parseGridData({
    region: "PJM",
    from_live_api: true,
    hours: [
      { hour: "2026-10-18T14:00:00Z", intensity_gco2_per_kwh: { low: 1, high: 2 }, source: "live!" },
      { hour: "2026-10-18T15:00:00Z", intensity_gco2_per_kwh: { low: 1, high: 2 }, source: "seeded" },
    ],
  });
  assert.equal(parsed.hours[0]?.source, "fallback");
  assert.equal(parsed.hours[1]?.source, "seeded");
});

test("a card mixing seeded and live hours reports the weaker provenance", () => {
  const grid: GridData = {
    region: "PJM",
    fetched_at: "2026-10-01T00:00:00Z",
    from_live_api: false,
    note: "mixed",
    hours: [
      {
        hour: "2026-10-01T00:00:00Z",
        intensity_gco2_per_kwh: { low: 400, high: 450, unit: "gCO2/kWh" },
        source: "eia",
      },
      {
        hour: "2026-10-02T00:00:00Z",
        intensity_gco2_per_kwh: { low: 400, high: 450, unit: "gCO2/kWh" },
        source: "seeded",
      },
    ],
  };
  const card = weeklyCard(eventsForCard(2, 50), config, { grid });
  assert.equal(card.provenance.gridSource, "seeded", "one live row must not make the card 'live'");
});

test("parseGridData rejects malformed rows instead of trusting them", () => {
  const parsed = parseGridData({
    region: "PJM",
    from_live_api: true,
    hours: [
      { hour: "2026-10-18T14:00:00Z", intensity_gco2_per_kwh: { low: 1, high: 2 }, source: "eia" },
      { hour: "bad-row-no-intensity" },
      { intensity_gco2_per_kwh: { low: 1, high: 2 } },
      "nonsense",
    ],
  });
  assert.equal(parsed.hours.length, 1);
  assert.equal(parsed.region, "PJM");
  assert.equal(parseGridData(null).hours.length, 0);
});

test("cleanest and dirtiest hours are found, and ignore fallback rows", () => {
  const grid = gridWith([
    { hour: "2026-10-18T02:00:00Z", low: 90, high: 110 },
    { hour: "2026-10-18T18:00:00Z", low: 500, high: 560 },
  ]);
  assert.equal(cleanestHour(grid)?.hour, "2026-10-18T02:00:00Z");
  assert.equal(dirtiestHour(grid)?.hour, "2026-10-18T18:00:00Z");
  assert.equal(cleanestHour(emptyGrid()), null);
});

// --- energy delta between tiers --------------------------------------------

test("dropping a tier shows a positive energy saving per 1k tokens", () => {
  const { range } = energyDeltaPer1kOutput(config, "large", "small");
  assert.ok(range.low > 0, "large -> small must save energy");
  assert.equal(range.unit, "Wh per 1k output tokens");
});

test("staying on the same tier saves nothing", () => {
  const { range } = energyDeltaPer1kOutput(config, "medium", "medium");
  assert.ok(range.low <= 0 && range.high >= 0, "a same-tier delta must straddle zero");
});

// --- weekly card ------------------------------------------------------------

function eventsForCard(count: number, wastedPerEvent: number): UsageEvent[] {
  return Array.from({ length: count }, (_, i) =>
    eventFrom({
      id: `evt_${i}`,
      timestamp: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
      tokens: { input: 50, cache_write: 0, cache_read: 0, output: 1000, reasoning: 0 },
      flags:
        wastedPerEvent > 0
          ? [
              {
                type: "filler",
                confidence: "high",
                tokens: wastedPerEvent,
                start: 0,
                end: 10,
                excerpt: "Great question!",
                why: "test",
              },
            ]
          : [],
    }),
  );
}

test("D9: the card reports efficiency, resources as ranges, and its baseline", () => {
  const card = weeklyCard(eventsForCard(10, 100), config, { isDemoData: true });
  assert.ok(card.efficiency > 0 && card.efficiency < 1);
  assert.equal(card.topWasteType, "filler");
  assert.ok(card.resources.energyWh.high >= card.resources.energyWh.low);
  assert.ok(card.baselineLabel.length > 0);
  assert.equal(card.isDemoData, true, "demo data must stay labelled all the way to the card");
});

test("with no history there is no change figure, and the card says why", () => {
  const card = weeklyCard(eventsForCard(5, 100), config);
  assert.equal(card.changePoints, null);
  assert.ok(card.provenance.assumptions.some((a) => a.includes("baseline")));
});

test("improvement against the baseline shows as a positive change", () => {
  const worse = eventsForCard(5, 300);
  const better = eventsForCard(5, 50).map((e, i) => ({
    ...e,
    id: `late_${i}`,
    timestamp: new Date(Date.UTC(2026, 10, 1 + i)).toISOString(),
  }));
  const card = weeklyCard([...worse, ...better], config, { baseline: { kind: "first_n", n: 5 } });
  assert.ok(card.changePoints !== null && card.changePoints > 0, "efficiency should have improved");
});

test("the card handles an empty history without throwing", () => {
  const card = weeklyCard([], config);
  assert.equal(card.efficiency, 1);
  assert.equal(card.eventsCounted, 0);
  assert.equal(card.topWasteType, null);
});

test("efficiency is token-weighted, so one short answer cannot swing it", () => {
  const big = eventFrom({
    tokens: { input: 0, cache_write: 0, cache_read: 0, output: 10000, reasoning: 0 },
    flags: [],
  });
  const tinyAllWaste = eventFrom({
    id: "tiny",
    tokens: { input: 0, cache_write: 0, cache_read: 0, output: 10, reasoning: 0 },
    flags: [
      { type: "filler", confidence: "high", tokens: 10, start: 0, end: 5, excerpt: "x", why: "t" },
    ],
  });
  assert.ok(efficiencyOf([big, tinyAllWaste]) > 0.99);
});

test("stored flags that overlap cannot push efficiency below zero", () => {
  const doubleCounted = eventFrom({
    tokens: { input: 0, cache_write: 0, cache_read: 0, output: 100, reasoning: 0 },
    flags: [
      { type: "echo", confidence: "high", tokens: 90, start: 0, end: 50, excerpt: "a", why: "t" },
      { type: "repetition", confidence: "high", tokens: 90, start: 0, end: 50, excerpt: "a", why: "t" },
    ],
  });
  assert.equal(efficiencyOf([doubleCounted]), 0);
});

// --- end to end -------------------------------------------------------------

test("runFullAnalysis produces every panel the portal needs", () => {
  const f = FIXTURES.find((x) => x.id === "echo-plus-filler")!;
  const result = runFullAnalysis(
    { prompt: f.prompt, response: f.response, modelClass: "large" },
    config,
  );

  assert.ok(result.analysis.flags.length > 0, "waste detection");
  assert.ok(result.estimate.wasted.energyWh.high > 0, "resource feedback");
  assert.ok(result.instructionBlock.lines.length > 0, "instruction block");
  assert.ok(result.rewrite.rewritten.length > 0, "prompt rewrite");
  assert.equal(result.suggestion.applied, false, "model suggestion must never self-apply");
  assert.equal(result.grid.source, "fallback");
  assert.deepEqual(result.configWarnings, [], "test config is clean");
  assert.equal(result.event.flags.length, result.analysis.flags.length);
});

test("runFullAnalysis survives every fixture", () => {
  for (const f of FIXTURES) {
    const r = runFullAnalysis(
      { prompt: f.prompt, response: f.response, modelClass: "medium" },
      config,
    );
    assert.ok(r.analysis.efficiency >= 0 && r.analysis.efficiency <= 1, `${f.id}: bad efficiency`);
    assert.ok(r.estimate.energyWh.high >= 0, `${f.id}: bad energy`);
  }
});

test("a rewrite with no gate verdict is marked unchecked", () => {
  const r = runFullAnalysis({ prompt: "Translate this to French: hello", response: "Bonjour", modelClass: "small" }, config);
  assert.equal(r.rewrite.checkedAgainstExamples, false);
});

test("analysis is deterministic: the same input gives the same score", () => {
  const f = FIXTURES.find((x) => x.id === "repetition-exact")!;
  const a = analyze(f.response, f.prompt);
  const b = analyze(f.response, f.prompt);
  assert.equal(a.efficiency, b.efficiency);
  assert.equal(a.wastedOutputTokens, b.wastedOutputTokens);
});
