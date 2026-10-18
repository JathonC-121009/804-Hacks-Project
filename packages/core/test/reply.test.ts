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

/**
 * Regression: a prompt that states its own length must never receive a second,
 * different one. Adding "answer in one or two sentences" to a prompt that said
 * "exactly 3 sentences" changes what the person asked for, which is the worst
 * thing this tool can do to a prompt.
 */
test("a prompt that states its own length is never given a contradicting one", async () => {
  const { rewritePrompt } = await import("../src/rewrite.ts");
  for (const prompt of [
    "What does the film show? Answer in exactly 3 sentences, no more and no less.",
    "Explain the Space Race. Answer in three sentences.",
    "Summarize this. Give exactly 5 bullets.",
    "Describe it in exactly 50 words.",
  ]) {
    const added = rewritePrompt(prompt).added.join(" ");
    assert.doesNotMatch(added, /sentence|word|bullet|point/i, `added a second limit to: ${prompt}\n  -> ${added}`);
  }
});

test("a prompt padded with definitions gets them stripped, and shrinks", async () => {
  const { rewritePrompt } = await import("../src/rewrite.ts");
  const padded =
    "A titanium cylinder, which is a metal container, was found under the ice, which is frozen water, " +
    "at a Soviet base, which is a research station, in Antarctica, which is a continent. What does it show?";
  const r = rewritePrompt(padded);
  assert.ok(r.tokenDelta < 0, `expected shrinkage, got ${r.tokenDelta}`);
  assert.ok(r.removed.length >= 3, `expected the definitions to be removed, got ${r.removed.length}`);
  assert.doesNotMatch(r.rewritten, /which is frozen water/i);
});

test("a single 'which is' clause is left alone, because it usually carries meaning", async () => {
  const { rewritePrompt } = await import("../src/rewrite.ts");
  const r = rewritePrompt("Explain the PJM grid, which is the market my data centre buys from.");
  assert.match(r.rewritten, /which is the market/i);
});

test("synonym chains collapse, and genuine lists are left alone", async () => {
  const { rewritePrompt } = await import("../src/rewrite.ts");
  assert.equal(
    rewritePrompt("What does it depict, show, illustrate, and display visually?").rewritten,
    "What does it depict visually?",
  );
  // A real list is not padding: collapsing it would delete what was asked for.
  const list = "Buy milk, eggs, and bread from the shop and tell me the total.";
  assert.equal(rewritePrompt(list).rewritten, list);
});

test("trimming never leaves a doubled conjunction or a wrong article", async () => {
  const { rewritePrompt } = await import("../src/rewrite.ts");
  for (const prompt of [
    "What does it depict, show, illustrate, and display?",
    "Find a totally undamaged, completely unruined, perfectly intact reel.",
    "Describe the sealed, closed, shut container.",
  ]) {
    const out = rewritePrompt(prompt).rewritten;
    assert.doesNotMatch(out, /\band\s+and\b/i, out);
    assert.doesNotMatch(out, /\ba\s+[aeiou]/i, out);
    assert.doesNotMatch(out, /\s,|,,/, out);
  }
});

test("trimming a padded prompt keeps every piece of real content", async () => {
  const { rewritePrompt } = await import("../src/rewrite.ts");
  const padded =
    "A sealed, closed off, tightly shut titanium cylinder was discovered beneath the ice, " +
    "which is frozen water, at a Soviet base, which is a research station, in Antarctica, " +
    "which is a continent. What does it reveal, disclose, and uncover about the Space Race? " +
    "Answer in exactly 3 sentences.";
  const r = rewritePrompt(padded);
  assert.ok(r.tokenDelta < 0, `expected shrinkage, got ${r.tokenDelta}`);
  for (const kept of ["discovered", "Antarctica", "Soviet", "Space Race", "exactly 3 sentences", "titanium"]) {
    assert.match(r.rewritten, new RegExp(kept, "i"), `lost "${kept}" from: ${r.rewritten}`);
  }
  assert.deepEqual(r.added, [], "a prompt that states its length must get no second one");
});
