import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cli = resolve("apps/cli/index.ts");

test("CLI returns provider-neutral JSON tagged as a CLI event", () => {
  const run = spawnSync(
    process.execPath,
    [
      cli,
      "analyze",
      "--prompt",
      "What is 1 plus 1?",
      "--response",
      "Great question. The answer is 2. I hope this helps.",
      "--tool",
      "gemini-cli",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.event.surface, "cli");
  assert.equal(result.event.tool, "gemini-cli");
  assert.ok(result.analysis.wastedOutputTokens > 0);
});

test("CLI accepts a piped response and exact usage counts", () => {
  const run = spawnSync(
    process.execPath,
    [
      cli,
      "analyze",
      "--prompt",
      "Explain DNS briefly",
      "--input-tokens",
      "4",
      "--output-tokens",
      "20",
      "--json",
    ],
    { encoding: "utf8", input: "DNS maps domain names to IP addresses." },
  );
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.event.token_source, "exact");
  assert.equal(result.event.tokens.output, 20);
});

test("CLI run automatically fixes the prompt before invoking an arbitrary AI command", () => {
  const fakeAi = [
    "-e",
    "process.stdout.write('AI received: ' + process.argv[1])",
    "{prompt}",
  ];
  const run = spawnSync(
    process.execPath,
    [
      cli,
      "run",
      "--prompt",
      "Please explain DNS please",
      "--no-color",
      "--",
      process.execPath,
      ...fakeAi,
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /AI received: Explain DNS/);
  assert.doesNotMatch(run.stdout, /No preamble, no closing offer, no recap/);
  assert.match(run.stderr, /Auto-fix applied:/);
  assert.match(run.stderr, /Suggested model:/);
  assert.match(run.stderr, /Efficiency/);
});
