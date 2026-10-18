import { test } from "node:test";
import assert from "node:assert/strict";

import { analyze } from "../src/index.ts";
import { lengthTargetWords } from "../src/detect.ts";

const long = Array.from({ length: 60 }, (_, i) => `Point ${i} explains another detail of the system in ordinary words.`).join(" ");

test("a reply far past the length the prompt asked for loses efficiency", () => {
  const r = analyze(long, "Explain it in 3 sentences.");
  assert.ok(r.efficiency < 0.5, `efficiency ${r.efficiency}`);
  assert.match(r.coverage.note, /scored against the 60-word target/);
});

test("a reply inside the requested length scores 100% and says length was checked", () => {
  const r = analyze("DNS maps names to addresses. It runs as a hierarchy of servers. Caching keeps lookups fast.", "Explain DNS in 3 sentences.");
  assert.equal(r.efficiency, 1);
  assert.equal(r.coverage.lengthTargetWords, 60);
});

test("with no stated length, 100% is marked as not measuring length", () => {
  const r = analyze(long, "Explain DNS");
  assert.equal(r.coverage.lengthTargetWords, null);
  assert.match(r.coverage.note, /Length was not scored/);
});

test("a closing recap that only repeats the body is scored", () => {
  const body = "Route simple work to a smaller model. Cap output length on well-defined tasks. Cache repeated requests. In summary, route smaller, cap output, cache repeats.";
  const r = analyze(body, "How can a team cut AI energy use?");
  assert.ok(r.flags.some((f) => f.type === "recap" && f.confidence === "high"));
  assert.ok(r.efficiency < 1);
});

test("length targets are read only from explicit numbers", () => {
  assert.equal(lengthTargetWords("Explain in 3 sentences."), 60);
  assert.equal(lengthTargetWords("Give 5 bullets."), 75);
  assert.equal(lengthTargetWords("Keep it under 120 words."), 120);
  assert.equal(lengthTargetWords("Explain briefly."), null);
});
