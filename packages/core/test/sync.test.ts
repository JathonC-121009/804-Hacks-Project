import { test } from "node:test";
import assert from "node:assert/strict";

import { syncUsageEvent, type Estimate } from "../src/index.ts";

const range = (unit: string) => ({ low: 1, high: 2, unit });
const estimate: Estimate = {
  energyWh: range("Wh"), waterMl: range("mL"), co2g: range("g"), cost: range("USD"),
  wasted: { energyWh: range("Wh"), waterMl: range("mL"), co2g: range("g"), cost: range("USD") },
  provenance: { unverified: [], assumptions: [], gridSource: "fallback" },
};

test("synced events contain measurements but never prompt or response text", () => {
  const event = syncUsageEvent({
    surface: "web",
    tool: "gemini",
    modelClass: "large",
    tokens: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
    totalOutputTokens: 20,
    wastedOutputTokens: 5,
    efficiency: 0.75,
    flags: [{ type: "filler", confidence: "high", tokens: 5, start: 0, end: 10, excerpt: "private text", why: "filler" }],
    estimate,
  });
  const serialized = JSON.stringify(event);
  assert.equal(event.efficiency, 0.75);
  assert.deepEqual(event.flagTypes, ["filler"]);
  assert.doesNotMatch(serialized, /private text/);
  assert.doesNotMatch(serialized, /excerpt|prompt|response/);
});
