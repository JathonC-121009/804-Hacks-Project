import { test } from "node:test";
import assert from "node:assert/strict";

import { analyze, detect } from "../src/detect.ts";
import { mergeIntervals, splitSentences } from "../src/text.ts";
import { FIXTURES } from "./fixtures.ts";

/** Acceptance criterion D1 from the plan. */
const REQUIRED_PRECISION = 0.9;

test("D1: high-confidence flags hit precision >= 0.9 across the fixtures", () => {
  let truePositives = 0;
  const falsePositives: string[] = [];
  let expectedTotal = 0;
  let found = 0;

  for (const f of FIXTURES) {
    const { flags } = detect(f.response, f.prompt);
    const high = flags.filter((x) => x.confidence === "high");
    const budget = new Map<string, number>();
    for (const t of f.expectHigh) budget.set(t, (budget.get(t) ?? 0) + 1);
    expectedTotal += f.expectHigh.length;
    found += high.length;

    for (const flag of high) {
      const left = budget.get(flag.type) ?? 0;
      if (left > 0) {
        budget.set(flag.type, left - 1);
        truePositives++;
      } else {
        falsePositives.push(`${f.id}: unexpected ${flag.type} -> "${flag.excerpt}"`);
      }
    }
  }

  const precision = found === 0 ? 1 : truePositives / found;
  const recall = expectedTotal === 0 ? 1 : truePositives / expectedTotal;

  // Printed so the team can see recall drifting even while the test passes.
  console.log(
    `  detectors: precision ${(precision * 100).toFixed(1)}% (${truePositives}/${found}), ` +
      `recall ${(recall * 100).toFixed(1)}% (${truePositives}/${expectedTotal})`,
  );

  assert.ok(
    precision >= REQUIRED_PRECISION,
    `precision ${precision.toFixed(3)} < ${REQUIRED_PRECISION}. False positives:\n  ${falsePositives.join("\n  ")}`,
  );
});

test("D1: every flag carries a usable span, except whole-response advisories", () => {
  for (const f of FIXTURES) {
    const { flags } = detect(f.response, f.prompt);
    for (const flag of flags) {
      const wholeResponseAdvisory =
        flag.confidence === "advisory" && flag.start === 0 && flag.end === 0;
      if (wholeResponseAdvisory) {
        assert.equal(flag.tokens, 0, `${f.id}: whole-response advisory must not claim tokens`);
        assert.ok(flag.why.length > 0, `${f.id}: advisory needs an explanation`);
        continue;
      }
      assert.ok(flag.end > flag.start, `${f.id}: ${flag.type} has an empty span`);
      assert.ok(flag.end <= f.response.length, `${f.id}: ${flag.type} span runs past the text`);
      assert.ok(flag.excerpt.length > 0, `${f.id}: ${flag.type} has no excerpt`);
      assert.ok(flag.why.length > 0, `${f.id}: ${flag.type} has no explanation`);
    }
  }
});

test("clean fixtures produce no scored flags at all", () => {
  for (const f of FIXTURES.filter((x) => x.expectHigh.length === 0)) {
    const { flags } = detect(f.response, f.prompt);
    const high = flags.filter((x) => x.confidence === "high");
    assert.deepEqual(
      high.map((x) => `${x.type}: ${x.excerpt}`),
      [],
      `${f.id} should be clean (${f.note})`,
    );
  }
});

test("advisory flags never move the efficiency score", () => {
  const advisoryOnly = FIXTURES.filter(
    (f) => f.expectHigh.length === 0 && (f.expectAdvisory?.length ?? 0) > 0,
  );
  assert.ok(advisoryOnly.length >= 3, "fixtures should cover several advisory-only cases");

  for (const f of advisoryOnly) {
    const result = analyze(f.response, f.prompt);
    assert.equal(result.wastedOutputTokens, 0, `${f.id}: advisory waste must not be counted`);
    assert.equal(result.efficiency, 1, `${f.id}: efficiency must stay at 1`);
  }
});

test("D2: efficiency stays in [0,1] and matches 1 - wasted/total", () => {
  for (const f of FIXTURES) {
    const r = analyze(f.response, f.prompt);
    assert.ok(r.efficiency >= 0 && r.efficiency <= 1, `${f.id}: efficiency out of range`);
    assert.ok(
      r.wastedOutputTokens <= r.totalOutputTokens,
      `${f.id}: waste exceeds total output`,
    );
    if (r.totalOutputTokens > 0) {
      const expected = 1 - r.wastedOutputTokens / r.totalOutputTokens;
      assert.ok(Math.abs(r.efficiency - expected) < 1e-9, `${f.id}: efficiency formula drifted`);
    }
  }
});

test("overlapping flags are merged, so waste is never double counted", () => {
  // A sentence that is both an echo of the prompt and a verbatim repeat.
  const prompt = "What is the difference between average and marginal carbon intensity?";
  const sentence =
    "The difference between average and marginal carbon intensity is worth stating precisely.";
  const response = `${sentence} Average divides emissions by generation. ${sentence}`;

  const { flags } = detect(response, prompt);
  const high = flags.filter((f) => f.confidence === "high");
  assert.ok(high.length >= 2, "expected both an echo and a repetition flag");

  const sumOfFlags = high.reduce((s, f) => s + f.tokens, 0);
  const result = analyze(response, prompt);
  assert.ok(
    result.wastedOutputTokens <= sumOfFlags,
    "merged waste should never exceed the sum of individual flags",
  );
  assert.ok(result.efficiency > 0, "efficiency must not collapse to zero from double counting");
});

test("waste share is stable whether token counts are real or estimated", () => {
  const f = FIXTURES.find((x) => x.id === "filler-closer")!;
  const estimated = analyze(f.response, f.prompt);
  const real = analyze(f.response, f.prompt, {
    tokens: { input: 20, cache_write: 0, cache_read: 0, output: 1000, reasoning: 0 },
    tokenSource: "exact",
  });

  assert.equal(real.totalOutputTokens, 1000);
  assert.equal(real.tokenSource, "exact");
  const shareEstimated = estimated.wastedOutputTokens / estimated.totalOutputTokens;
  const shareReal = real.wastedOutputTokens / real.totalOutputTokens;
  assert.ok(
    Math.abs(shareEstimated - shareReal) < 0.05,
    `waste share drifted between modes: ${shareEstimated} vs ${shareReal}`,
  );
});

test("prompt-side flags are reported separately and always advisory", () => {
  const f = FIXTURES.find((x) => x.id === "advisory-prompt-side")!;
  const { promptFlags } = detect(f.response, f.prompt);
  assert.ok(promptFlags.length > 0, "expected prompt-side findings");
  for (const flag of promptFlags) {
    assert.equal(flag.confidence, "advisory");
    assert.equal(flag.type, "prompt_side");
  }
});

test("detection works with no prompt supplied", () => {
  const r = analyze("Great question! The answer is 42.");
  assert.ok(r.flags.some((f) => f.type === "filler"), "filler should still fire without a prompt");
  assert.ok(!r.flags.some((f) => f.type === "echo"), "echo needs a prompt and must not guess");
});

test("empty input is handled without throwing", () => {
  const r = analyze("", "");
  assert.equal(r.efficiency, 1);
  assert.equal(r.wastedOutputTokens, 0);
  assert.deepEqual(r.flags, []);
});

test("splitSentences keeps offsets that index back into the original text", () => {
  const text = "First one. Second one!\n\nThird one?";
  const spans = splitSentences(text);
  assert.equal(spans.length, 3);
  for (const s of spans) {
    assert.equal(text.slice(s.start, s.end), s.text);
  }
});

test("mergeIntervals collapses overlaps and touching ranges", () => {
  assert.deepEqual(
    mergeIntervals([
      { start: 0, end: 5 },
      { start: 3, end: 8 },
      { start: 20, end: 25 },
      { start: 8, end: 10 },
    ]),
    [
      { start: 0, end: 10 },
      { start: 20, end: 25 },
    ],
  );
  assert.deepEqual(mergeIntervals([]), []);
});
