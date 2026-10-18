import { test } from "node:test";
import assert from "node:assert/strict";

import { detect } from "../src/detect.ts";
import { buildInstructionBlock, INSTRUCTION_CAVEATS } from "../src/instructions.ts";
import { detectTaskType, REWRITE_CAVEATS, rewritePrompt } from "../src/rewrite.ts";
import { footprintDeltaForResponse, suggestModel } from "../src/suggestModel.ts";
import { countWords } from "../src/text.ts";
import type { Flag } from "../src/types.ts";
import { FIXTURES, testConfig } from "./fixtures.ts";

const config = testConfig();

function flag(type: Flag["type"], tokens: number): Flag {
  return { type, confidence: "high", tokens, start: 0, end: 10, excerpt: "x", why: "test" };
}

// --- fix 1: standing instruction block -------------------------------------

test("D2: the instruction block stays under 60 words", () => {
  // Every line at once: the worst case for length.
  const all: Flag[] = [
    flag("echo", 50),
    flag("filler", 50),
    flag("repetition", 50),
    flag("recap", 50),
    flag("boilerplate", 50),
    flag("overlength", 50),
  ];
  const block = buildInstructionBlock(all);
  assert.ok(block.wordCount <= 60, `block was ${block.wordCount} words: ${block.block}`);
  assert.equal(countWords(block.block), block.wordCount);
});

test("the block only addresses waste that was actually seen", () => {
  const block = buildInstructionBlock([flag("filler", 20)]);
  assert.equal(block.lines.length, 1);
  assert.match(block.lines[0]!, /greeting/i);
  assert.ok(!block.block.toLowerCase().includes("restate"), "no echo line when there was no echo");
});

test("the heaviest waste type leads the block", () => {
  const block = buildInstructionBlock([flag("filler", 5), flag("repetition", 500)]);
  assert.equal(block.basedOn[0]?.type, "repetition");
  assert.match(block.lines[0]!, /repeat/i);
});

test("history shapes the block, not just this one response", () => {
  const block = buildInstructionBlock([flag("filler", 10)], [flag("echo", 900)]);
  assert.equal(block.basedOn[0]?.type, "echo");
});

test("no waste means no block", () => {
  const block = buildInstructionBlock([]);
  assert.deepEqual(block.lines, []);
  assert.equal(block.block, "");
  assert.equal(block.wordCount, 0);
});

test("advisory waste still earns advice even though it is never scored", () => {
  const advisory: Flag = { ...flag("recap", 0), confidence: "advisory" };
  const block = buildInstructionBlock([advisory]);
  assert.ok(block.lines.some((l) => /recap|summary/i.test(l)));
});

test("the block ships with its caveats, including the quality warning", () => {
  assert.ok(INSTRUCTION_CAVEATS.some((c) => /quality|complex/i.test(c)));
  assert.ok(INSTRUCTION_CAVEATS.some((c) => /every message/i.test(c)));
});

// --- fix 2: per-prompt rewrite ---------------------------------------------

test("task type is detected from the prompt", () => {
  assert.equal(detectTaskType("Translate this into Spanish: hello"), "translate");
  assert.equal(detectTaskType("Classify the sentiment of this review"), "classify");
  assert.equal(detectTaskType("Extract all the dates from this text"), "extract");
  assert.equal(detectTaskType("Summarize this article"), "summarize");
  assert.equal(detectTaskType("Proofread this paragraph"), "rewrite");
  assert.equal(detectTaskType("```js\nconst x = 1\n```\nWhat is wrong here?"), "code");
  assert.equal(detectTaskType("Why does evaporative cooling use so much water?"), "reasoning");
  assert.equal(detectTaskType("Tell me about Virginia"), "general");
});

test("D4: politeness goes, the instruction stays", () => {
  const r = rewritePrompt("Please summarize this article for me. Thanks in advance!");
  assert.ok(/summarize this article/i.test(r.rewritten), "the actual task must survive");
  assert.ok(!/thanks in advance/i.test(r.rewritten), "the pleasantry should be gone");
  assert.ok(!/\bplease\b/i.test(r.rewritten), "politeness should be stripped");
  assert.ok(r.removed.length > 0, "removals must be explained");
  for (const removal of r.removed) assert.ok(removal.why.length > 0);
});

test("D4: a repeated instruction is removed once, not both times", () => {
  const r = rewritePrompt(
    "Summarize the article below in five bullet points. " +
      "Please summarize the article below in five bullet points.",
  );
  const mentions = (r.rewritten.match(/summarize the article/gi) ?? []).length;
  assert.equal(mentions, 1, `expected one mention, got: ${r.rewritten}`);
  assert.ok(r.removed.some((x) => /repeats an instruction/i.test(x.why)));
});

test("politeness is stripped before the duplicate check, so a 'please' cannot hide a repeat", () => {
  // Without stripping first, the stray "please" drops word-set overlap below
  // the threshold and the repeat survives.
  const r = rewritePrompt("Translate the paragraph into French. Please translate the paragraph into French.");
  assert.equal((r.rewritten.match(/translate the paragraph/gi) ?? []).length, 1);
});

test("a paraphrased repeat is knowingly NOT caught, and the limit is documented", () => {
  // "Please summarize this article" vs "I would like a summary of the article"
  // share almost no words. Catching this needs sentence meaning, which would
  // mean a model call: energy spent to save energy, and the prompt leaving the
  // device. Out of scope by choice, so the pitch can say so plainly.
  const f = FIXTURES.find((x) => x.id === "advisory-prompt-side")!;
  const r = rewritePrompt(f.prompt);
  assert.equal(
    (r.rewritten.match(/summar/gi) ?? []).length,
    2,
    "if this ever becomes 1, semantic dedupe was added and the pitch claim must change",
  );
  assert.ok(r.removed.length > 0, "the politeness in it is still caught");
});

test("D4: output directions are appended, and that is where the saving is", () => {
  const r = rewritePrompt("Classify the sentiment of this review: it was fine.");
  assert.equal(r.taskType, "classify");
  assert.ok(r.added.length > 0);
  assert.ok(/label only/i.test(r.rewritten), "a classify task should ask for the label only");
  assert.ok(REWRITE_CAVEATS.some((c) => /output directions/i.test(c)));
});

test("hard reasoning gets no length cap, because brevity costs accuracy there", () => {
  const r = rewritePrompt("Why does marginal emissions data matter for a scheduler?");
  assert.equal(r.taskType, "reasoning");
  const directions = r.added.join(" ");
  assert.ok(!/at most \d+|bullet|only/i.test(directions), `unexpected cap: ${directions}`);
  assert.ok(/no preamble|no recap/i.test(directions));
});

test("D4: the diff accounts for every sentence, and nothing is applied on its own", () => {
  const r = rewritePrompt("Please summarize this. Thanks in advance!");
  assert.ok(r.diff.length > 0);
  assert.ok(r.diff.some((d) => d.op === "remove"));
  assert.ok(r.diff.some((d) => d.op === "add"));
  assert.equal(r.original, "Please summarize this. Thanks in advance!", "the original must be preserved for the diff");
  assert.equal(r.checkedAgainstExamples, false, "unchecked by default");
});

test("D4: long pasted blocks are flagged for the user, never removed", () => {
  const pasted = Array.from({ length: 80 }, (_, i) => `token${i}`).join(" ");
  const r = rewritePrompt(`Summarize the email below.\n\n> ${pasted}`);
  assert.ok(r.flaggedContext.length > 0, "the pasted block should be flagged");
  assert.ok(r.flaggedContext[0]!.words >= 60);
  assert.ok(r.rewritten.includes("Summarize the email below"), "the instruction stays");
  assert.ok(REWRITE_CAVEATS.some((c) => /flagged, never removed/i.test(c)));
});

test("a short prompt with nothing to trim still gets output directions", () => {
  const r = rewritePrompt("What is PUE?");
  assert.equal(r.removed.length, 0);
  assert.ok(r.added.length > 0);
  assert.ok(r.rewritten.startsWith("What is PUE?"));
});

test("an already-tight prompt is not mangled", () => {
  const prompt = "Translate to French: the grid is clean tonight.";
  const r = rewritePrompt(prompt);
  assert.ok(r.rewritten.includes("Translate to French"), `lost the task: ${r.rewritten}`);
});

test("the rewrite reports a token delta and can be bigger than the original", () => {
  // Appending directions to a tiny prompt legitimately grows it. Honest output
  // beats pretending every rewrite is shorter.
  const r = rewritePrompt("Define PUE.");
  assert.equal(typeof r.tokenDelta, "number");
  assert.ok(r.tokenDelta > 0, "a three-word prompt plus directions must get longer");
});

test("a verbose prompt genuinely shrinks", () => {
  const verbose =
    "Hi there! I was wondering if you could please summarize the article below for me. " +
    "I would really like a summary of the article below please. Thanks in advance for your help!";
  const r = rewritePrompt(verbose);
  assert.ok(r.tokenDelta < 0, `expected a shorter prompt, delta was ${r.tokenDelta}`);
});

test("D4: rewriting a rewrite is a no-op, so clicking trim twice cannot grow a prompt", () => {
  const verbose =
    "Hi there! I hope you're doing well. I was wondering if you could please explain " +
    "why the leaves on my monstera are turning yellow. Thanks in advance for your help!";

  const once = rewritePrompt(verbose);
  const twice = rewritePrompt(once.rewritten);

  assert.equal(twice.rewritten, once.rewritten, "a second pass must change nothing");
  assert.equal(twice.added.length, 0, "directions already in the prompt must not be added again");
  assert.equal(twice.tokenDelta, 0);

  for (const line of once.added) {
    const occurrences = once.rewritten.split(line).length - 1;
    assert.equal(occurrences, 1, `"${line}" appears ${occurrences} times: ${once.rewritten}`);
  }
});

test("a direction the user already wrote themselves is not repeated back at them", () => {
  const base = rewritePrompt("Explain why my monstera is yellowing.");
  const r = rewritePrompt(`Explain why my monstera is yellowing. ${base.added.join(" ")}`);
  assert.equal(r.added.length, 0);
  assert.ok(!r.diff.some((d) => d.op === "add"), "nothing to add means nothing added in the diff");
});

// --- fix 2b: the directions are chosen, not boilerplate ---------------------

test("the directions follow the waste this user actually gets", () => {
  const prompt = "Explain why my monstera is yellowing.";
  const echoer = rewritePrompt(prompt, undefined, { wasteProfile: { echo: 300 } });
  const rambler = rewritePrompt(prompt, undefined, { wasteProfile: { repetition: 300 } });

  assert.ok(echoer.added.some((l) => /restate my question/i.test(l)), echoer.added.join(" | "));
  assert.ok(rambler.added.some((l) => /same point twice/i.test(l)), rambler.added.join(" | "));
  assert.notDeepEqual(echoer.added, rambler.added, "two different problems must not get the same advice");
});

test("the heaviest waste types win, and the block stays short", () => {
  const r = rewritePrompt("Explain why my monstera is yellowing.", undefined, {
    wasteProfile: { echo: 500, filler: 400, recap: 3, boilerplate: 1 },
  });
  assert.ok(r.added.length <= 3, `too many directions: ${r.added.length}`);
  assert.ok(r.added.some((l) => /restate my question/i.test(l)));
  assert.ok(!r.added.some((l) => /disclaimer/i.test(l)), "the lightest waste should be dropped");
});

test("with no history at all, the directions still say something useful", () => {
  const r = rewritePrompt("Explain why my monstera is yellowing.");
  assert.ok(r.added.length > 0);
  assert.ok(/no preamble/i.test(r.added.join(" ")));
});

test("the prompt itself earns a length direction when the task type has none", () => {
  const lookup = rewritePrompt("What is PUE?");
  assert.ok(/one or two sentences/i.test(lookup.added.join(" ")), lookup.added.join(" | "));

  // A task type with its own shape keeps it: "label only" beats any guess
  // made from the wording of the question.
  const classify = rewritePrompt("Classify the sentiment of this review: it was fine.");
  assert.ok(/label only/i.test(classify.added.join(" ")));
});

test("a prompt carrying pasted text is told not to quote it back", () => {
  const pasted = Array.from({ length: 80 }, (_, i) => `token${i}`).join(" ");
  const r = rewritePrompt(`Summarize the email below.\n\n> ${pasted}`);
  assert.ok(/do not quote the text above/i.test(r.added.join(" ")), r.added.join(" | "));
});

test("the rewrite never throws on any fixture prompt", () => {
  for (const f of FIXTURES) {
    const r = rewritePrompt(f.prompt);
    assert.ok(r.rewritten.length > 0, `${f.id}: rewrite came back empty`);
  }
});

// --- fix 3: model suggestion ------------------------------------------------

test("D5: a mechanical task suggests a smaller model", () => {
  const s = suggestModel("Translate this sentence into Spanish: the server is hot.", config, "large");
  assert.equal(s.suggestedTier, "small");
  assert.equal(s.isDowngrade, true);
  assert.ok(s.footprintDeltaPer1kOutput.low > 0);
  assert.match(s.label, /likely sufficient/i);
});

test("D5: hard work stays on the big model, with no saving claimed", () => {
  const s = suggestModel(
    "```python\ndef f(x): return x\n```\nDebug this stack trace and design a fix step by step, analysing the trade-offs.",
    config,
    "large",
  );
  assert.equal(s.suggestedTier, "large");
  assert.equal(s.isDowngrade, false);
  assert.ok(s.caveats.some((c) => /no saving available/i.test(c)));
});

test("D5: the suggestion never applies itself", () => {
  const s = suggestModel("Translate this into French.", config, "large");
  assert.equal(s.applied, false);
  assert.ok(s.caveats.some((c) => /never switch/i.test(c)));
});

test("D5: every signal is returned so the reasoning is visible", () => {
  const s = suggestModel("Classify this review's sentiment.", config);
  assert.ok(s.signals.length > 0);
  for (const sig of s.signals) {
    assert.equal(typeof sig.hit, "boolean");
    assert.equal(typeof sig.weight, "number");
    assert.ok(sig.name.length > 0);
  }
  assert.ok(s.signals.some((x) => x.hit), "at least one signal should have fired");
});

test("D5: a borderline prompt reports low confidence and says so", () => {
  const s = suggestModel("Write a short note about cooling towers for our wiki.", config);
  if (s.confidence === "low") {
    assert.ok(s.caveats.some((c) => /low confidence/i.test(c)));
  }
  assert.ok(["low", "medium", "high"].includes(s.confidence));
});

test("D5: the retry risk is always stated", () => {
  const s = suggestModel("Translate this into German.", config, "large");
  assert.ok(s.caveats.some((c) => /retry|retries|two attempts/i.test(c)));
});

test("the assumed current tier comes from config and is reported", () => {
  const s = suggestModel("Translate this.", config);
  assert.equal(s.assumedCurrentTier, config.models.default_assumed_tier);
  const override = suggestModel("Translate this.", config, "medium");
  assert.equal(override.assumedCurrentTier, "medium");
});

test("the per-response saving scales from the per-1k figure", () => {
  const s = suggestModel("Translate this into Spanish.", config, "large");
  const forResponse = footprintDeltaForResponse(s, 2000);
  assert.ok(Math.abs(forResponse.low - s.footprintDeltaPer1kOutput.low * 2) < 1e-9);
  assert.equal(forResponse.unit, "Wh");
});

test("the suggester never throws on any fixture prompt", () => {
  for (const f of FIXTURES) {
    const s = suggestModel(f.prompt, config);
    assert.ok(["small", "medium", "large"].includes(s.suggestedTier), `${f.id}: bad tier`);
  }
});

// --- the three fixes together ----------------------------------------------

test("a wasteful exchange produces all three fixes at once", () => {
  const prompt = "Please could you tell me why Virginia has so many data centers? Thanks in advance!";
  const response =
    "Great question! You asked why Virginia has so many data centers. Dense fiber, cheap power, and tax incentives. I hope this helps!";

  const { flags } = detect(response, prompt);
  const block = buildInstructionBlock(flags);
  const rewrite = rewritePrompt(prompt);
  const suggestion = suggestModel(prompt, config, "large");

  assert.ok(block.lines.length >= 2, "block should cover both filler and echo");
  assert.ok(rewrite.removed.length > 0, "rewrite should find politeness to cut");
  assert.ok(["small", "medium", "large"].includes(suggestion.suggestedTier));
  assert.equal(suggestion.applied, false);
});
