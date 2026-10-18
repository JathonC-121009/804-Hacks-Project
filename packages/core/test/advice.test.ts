import { test } from "node:test";
import assert from "node:assert/strict";

import { adviseOnPrompt, type AdviceKind } from "../src/advice.ts";

/**
 * Labelled prompts. Each names the advice it should get, or "none" for a prompt
 * that is already well specified. The negatives matter as much as the
 * positives: advice that fires on a good prompt teaches people to ignore it.
 */
const LABELLED: { prompt: string; expect: AdviceKind | "none" }[] = [
  { prompt: "Explain DNS please", expect: "unbounded" },
  { prompt: "What is a CDN?", expect: "unbounded" },
  { prompt: "Write a cover letter for a barista job", expect: "unbounded" },
  { prompt: "Explain how DNS works and also list the record types", expect: "multi_ask" },
  { prompt: "Why is my sourdough flat? What should I change?", expect: "multi_ask" },
  { prompt: "make it better", expect: "vague_goal" },
  { prompt: "My build fails, please help", expect: "missing_error" },
  { prompt: "My build fails with TypeError: cannot read property of undefined", expect: "none" },
  { prompt: "In 3 bullet points, explain DNS for a beginner.", expect: "none" },
  {
    prompt:
      "You are a scout stationed at a hidden watchtower in 1659. The dense forests of the valley are covered in thick evening fog, and through the mist you spot the advancing torches of an approaching army. Write a suspenseful story, under 200 words, about carrying the warning through the dark.",
    expect: "none",
  },
  {
    prompt: "Why does this fail?\n\n```\n" + "const rows = data.map(r => r.id);\n".repeat(20) + "```",
    expect: "large_paste",
  },
  { prompt: "Summarize this in under 100 words: the server rotated keys at noon.", expect: "none" },
  { prompt: "Reply with the Spanish translation only: the server is hot.", expect: "none" },
  { prompt: "Write a cover letter for a barista job. Keep it under 150 words.", expect: "none" },
];

test("each labelled prompt gets the advice it should, and no more", () => {
  for (const { prompt, expect } of LABELLED) {
    const kinds = adviseOnPrompt(prompt).map((a) => a.kind);
    if (expect === "none") {
      assert.deepEqual(kinds, [], `false alarm on: ${prompt} -> ${kinds}`);
    } else {
      assert.ok(kinds.includes(expect), `missed ${expect} on: ${prompt} -> ${kinds}`);
    }
  }
});

test("precision and recall over the labelled set are reported and stay high", () => {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const { prompt, expect } of LABELLED) {
    const kinds = new Set(adviseOnPrompt(prompt).map((a) => a.kind));
    if (expect === "none") {
      if (kinds.size > 0) falsePositive += 1;
    } else if (kinds.has(expect)) {
      truePositive += 1;
    } else {
      falseNegative += 1;
    }
  }
  const precision = truePositive / Math.max(1, truePositive + falsePositive);
  const recall = truePositive / Math.max(1, truePositive + falseNegative);
  console.log(`  advice precision ${(precision * 100).toFixed(0)}%, recall ${(recall * 100).toFixed(0)}% on ${LABELLED.length} labelled prompts`);
  assert.ok(precision >= 0.8, `precision ${precision}`);
  assert.ok(recall >= 0.8, `recall ${recall}`);
});

test("every suggestion quotes the prompt and names a concrete change", () => {
  for (const advice of adviseOnPrompt("Explain how DNS works and also list the record types")) {
    assert.ok(advice.quote.length > 0);
    assert.ok(advice.suggestion.length > 20, advice.suggestion);
  }
});

test("a prompt with no request in it gets no advice", () => {
  assert.deepEqual(adviseOnPrompt("   "), []);
});
