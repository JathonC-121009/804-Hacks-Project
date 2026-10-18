import { test } from "node:test";
import assert from "node:assert/strict";

import {
  exampleSetHash,
  GATE_DEFAULTS,
  isVerdictStale,
  matches,
  netOfCheck,
  recordedRunner,
  runGate,
} from "../src/gate.ts";
import type { Change, Example, GateRunner, Task, TokenCounts } from "../src/types.ts";
import { testConfig } from "./fixtures.ts";

const config = testConfig();

const classifyTask: Task = {
  id: "ticket-triage",
  name: "Support ticket triage",
  task_type: "classify",
  match_rule: { kind: "exact" },
  baseline_prompt: "Classify this support ticket as billing, bug, or question.",
};

const summarizeTask: Task = {
  id: "ticket-summary",
  name: "Support ticket summary",
  task_type: "summarize",
  match_rule: { kind: "key_facts" },
  baseline_prompt: "Summarize this support ticket.",
};

const change: Change = {
  type: "prompt_rewrite",
  value: "shortened",
  description: "Reply with the label only.",
};

function examples(n: number): Example[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ex_${i}`,
    input: `ticket ${i}`,
    expected: i % 2 === 0 ? "billing" : "bug",
  }));
}

function tokens(output: number): TokenCounts {
  return { input: 40, cache_write: 0, cache_read: 0, output, reasoning: 0 };
}

/** A runner that returns the expected answer for all but `failFor` example ids. */
function fakeRunner(failFor: string[] = [], outputTokens = 5): GateRunner {
  return async ({ example }) => ({
    output: failFor.includes(example.id) ? "totally wrong" : example.expected,
    tokens: tokens(outputTokens),
  });
}

// --- match rules ------------------------------------------------------------

test("exact matching ignores case and spacing but not content", () => {
  const ex: Example = { id: "e", input: "i", expected: "Billing" };
  assert.equal(matches(classifyTask, ex, "billing").ok, true);
  assert.equal(matches(classifyTask, ex, "  BILLING  ").ok, true);
  assert.equal(matches(classifyTask, ex, "bug").ok, false);
});

test("key-facts matching requires every fact, and names the missing ones", () => {
  const ex: Example = {
    id: "e",
    input: "i",
    expected: "Customer was double charged in March and wants a refund.",
    key_facts: ["double charged", "refund", "March"],
  };
  assert.equal(matches(summarizeTask, ex, "Double charged in March; requests a refund.").ok, true);

  const partial = matches(summarizeTask, ex, "The customer was double charged.");
  assert.equal(partial.ok, false);
  assert.match(partial.reason, /refund/);
  assert.match(partial.reason, /March/);
});

test("an example with no key facts written fails loudly instead of passing by default", () => {
  const ex: Example = { id: "e", input: "i", expected: "something" };
  const r = matches(summarizeTask, ex, "anything at all");
  assert.equal(r.ok, false);
  assert.match(r.reason, /No key_facts/);
});

test("a length limit is judged by whether the final field survived", () => {
  const task: Task = {
    ...classifyTask,
    match_rule: { kind: "length_limit", required_final_field: "Next step:" },
  };
  const ex: Example = { id: "e", input: "i", expected: "x" };
  assert.equal(matches(task, ex, "Summary here. Next step: refund the customer.").ok, true);
  const cut = matches(task, ex, "Summary here. The customer was double char");
  assert.equal(cut.ok, false);
  assert.match(cut.reason, /truncated/i);
});

// --- running the gate -------------------------------------------------------

test("D6: a passing change reports its pass rate and passes", async () => {
  const v = await runGate(classifyTask, change, examples(20), fakeRunner(), config);
  assert.equal(v.examples_run, 20);
  assert.equal(v.passes, 20);
  assert.equal(v.pass_rate, 1);
  assert.equal(v.passed, true);
  assert.deepEqual(v.failures, []);
});

test("D6: a failing change returns fail and lists which examples broke", async () => {
  const v = await runGate(classifyTask, change, examples(20), fakeRunner(["ex_3", "ex_7", "ex_11"]), config);
  assert.equal(v.passes, 17);
  assert.equal(v.pass_rate, 0.85);
  assert.equal(v.passed, false, "0.85 is below the 0.95 default threshold");
  assert.equal(v.failures.length, 3);
  assert.deepEqual(v.failures.map((f) => f.example_id), ["ex_3", "ex_7", "ex_11"]);
  for (const f of v.failures) {
    assert.ok(f.reason.length > 0, "a failure must say why");
    assert.ok(f.expected.length > 0);
    assert.ok(f.got.length > 0);
  }
});

test("the default threshold is 0.95 and can be overridden per team", async () => {
  assert.equal(GATE_DEFAULTS.threshold, 0.95);
  const lenient = await runGate(classifyTask, change, examples(20), fakeRunner(["ex_3"]), config, {
    threshold: 0.9,
  });
  assert.equal(lenient.passed, true);
  const strict = await runGate(classifyTask, change, examples(20), fakeRunner(["ex_3"]), config, {
    threshold: 1,
  });
  assert.equal(strict.passed, false);
});

test("the gate refuses to run with no examples, rather than calling a change safe", async () => {
  await assert.rejects(
    () => runGate(classifyTask, change, [], fakeRunner(), config),
    /at least one example/,
  );
});

// --- the gate's own cost ----------------------------------------------------

test("the gate measures what it cost to run", async () => {
  const v = await runGate(classifyTask, change, examples(10), fakeRunner([], 50), config);
  assert.ok(v.check_cost.tokens > 0, "the check is not free and must say so");
  assert.ok(v.check_cost.energyWh.high > 0);
  assert.ok(v.check_cost.energyWh.high >= v.check_cost.energyWh.low);
});

test("net-of-check savings subtract the gate's own energy", async () => {
  const v = await runGate(classifyTask, change, examples(10), fakeRunner([], 50), config);
  const gross = { low: 10, high: 20, unit: "Wh" };
  const net = netOfCheck(gross, v);
  assert.ok(net.low < gross.low, "net must be below gross");
  assert.ok(net.high < gross.high);
  assert.equal(net.unit, "Wh");
});

test("a check that costs more than it saves shows as a negative net, not a hidden one", async () => {
  const expensive = await runGate(classifyTask, change, examples(20), fakeRunner([], 100000), config);
  const tinySaving = { low: 0.001, high: 0.002, unit: "Wh" };
  const net = netOfCheck(tinySaving, expensive);
  assert.ok(net.high < 0, "the paradox has to be visible when it happens");
});

// --- recorded runs ----------------------------------------------------------

test("D6: a recorded run is tagged so it can never be shown as live", async () => {
  const records = Object.fromEntries(
    examples(10).map((e) => [e.id, { output: e.expected, tokens: tokens(5) }]),
  );
  const v = await runGate(classifyTask, change, examples(10), recordedRunner(records), config);
  assert.equal(v.runner_kind, "recorded");
  assert.equal(v.passed, true);
});

test("a live runner is tagged live", async () => {
  const v = await runGate(classifyTask, change, examples(5), fakeRunner(), config);
  assert.equal(v.runner_kind, "live");
});

test("a recorded runner with a missing capture fails loudly instead of inventing one", async () => {
  const records = { ex_0: { output: "billing", tokens: tokens(5) } };
  await assert.rejects(
    () => runGate(classifyTask, change, examples(3), recordedRunner(records), config),
    /no captured output/,
  );
});

test("recorded captures can be keyed per change, so two changes do not share answers", async () => {
  const records = {
    "prompt_rewrite:shortened:ex_0": { output: "billing", tokens: tokens(5) },
    "model_tier:small:ex_0": { output: "wrong", tokens: tokens(5) },
  };
  const one: Example[] = [{ id: "ex_0", input: "t", expected: "billing" }];

  const good = await runGate(classifyTask, change, one, recordedRunner(records), config);
  assert.equal(good.passed, true);

  const tierChange: Change = { type: "model_tier", value: "small", description: "try small" };
  const bad = await runGate(classifyTask, tierChange, one, recordedRunner(records), config);
  assert.equal(bad.passed, false);
});

// --- verdict lifetime -------------------------------------------------------

test("a verdict records what it was checked against, and when it expires", async () => {
  const now = new Date("2026-10-18T12:00:00Z");
  const ex = examples(10);
  const v = await runGate(classifyTask, change, ex, fakeRunner(), config, { now });

  assert.equal(v.checked_at, now.toISOString());
  assert.equal(v.example_set_hash, exampleSetHash(ex));
  assert.equal(v.task_id, "ticket-triage");
  assert.equal(v.change_type, "prompt_rewrite");

  const expires = new Date(v.expires_at);
  const days = (expires.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
  assert.equal(days, GATE_DEFAULTS.ttlDays);
});

test("a fresh verdict is not stale", async () => {
  const ex = examples(10);
  const v = await runGate(classifyTask, change, ex, fakeRunner(), config);
  assert.equal(isVerdictStale(v, ex), null);
});

test("an expired verdict must be re-run", async () => {
  const ex = examples(10);
  const v = await runGate(classifyTask, change, ex, fakeRunner(), config, {
    now: new Date("2026-01-01T00:00:00Z"),
  });
  const stale = isVerdictStale(v, ex, new Date("2026-10-18T00:00:00Z"));
  assert.match(stale ?? "", /expired/i);
});

test("changing the examples invalidates the verdict", async () => {
  const ex = examples(10);
  const v = await runGate(classifyTask, change, ex, fakeRunner(), config);
  const edited = [...ex, { id: "ex_new", input: "new ticket", expected: "question" }];
  assert.match(isVerdictStale(v, edited) ?? "", /example set changed/i);
});

test("the example-set hash is stable for the same set and differs for others", () => {
  assert.equal(exampleSetHash(examples(5)), exampleSetHash(examples(5)));
  assert.notEqual(exampleSetHash(examples(5)), exampleSetHash(examples(6)));
});

// --- why it runs once per task ---------------------------------------------

test("the gate is run once per task, not once per request", async () => {
  // Proves the cost model: 20 examples is a one-off spend whose verdict is
  // reused. Re-running it per request is what the design exists to avoid.
  let calls = 0;
  const counting: GateRunner = async ({ example }) => {
    calls++;
    return { output: example.expected, tokens: tokens(5) };
  };
  const ex = examples(20);
  const v = await runGate(classifyTask, change, ex, counting, config);
  assert.equal(calls, 20, "one call per example, once");
  assert.equal(isVerdictStale(v, ex), null, "and the verdict is then reusable");
});
