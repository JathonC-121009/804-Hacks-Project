import type {
  Change,
  Config,
  Example,
  GateFailure,
  GateRunner,
  ModelClass,
  Range,
  Task,
  TokenCounts,
  Verdict,
} from "./types.ts";
import { normalize, stableHash } from "./text.ts";
import { newCollector, outputEnergyPerToken, scaleRange } from "./config.ts";
import { outputTokens } from "./tokens.ts";

/**
 * Quality gate (plan section 7).
 *
 * Why this exists: every other feature here tells someone to make their AI say
 * less. The obvious objection is "does the answer get worse?" The gate is the
 * answer, and without it the product is just advice.
 *
 * Why it runs once per task and not per request: checking costs tokens. Running
 * it on every request would burn more energy than the change saves, which is
 * the paradox the whole design has to avoid. So a task is checked once, the
 * verdict is stored and reused, and it expires rather than lasting forever.
 *
 * The gate's own cost is measured and reported so savings can be shown
 * net-of-check. A check that costs more than it protects should be visible.
 */

const DEFAULT_THRESHOLD = 0.95;
const VERDICT_TTL_DAYS = 30;

export const GATE_DEFAULTS = {
  threshold: DEFAULT_THRESHOLD,
  ttlDays: VERDICT_TTL_DAYS,
};

export function exampleSetHash(examples: Example[]): string {
  const material = examples.map((e) => `${e.id}\u0000${e.input}\u0000${e.expected}`).join("\u0001");
  return stableHash(material);
}

/** Does this output still count as correct? One rule per task type. */
export function matches(task: Task, example: Example, output: string): { ok: boolean; reason: string } {
  const rule = task.match_rule;

  if (rule.kind === "exact") {
    const ok = normalize(output) === normalize(example.expected);
    return { ok, reason: ok ? "Exact match." : "Label or value differs from the expected answer." };
  }

  if (rule.kind === "key_facts") {
    const facts = example.key_facts ?? [];
    if (facts.length === 0) {
      return {
        ok: false,
        reason: "No key_facts written for this example, so it cannot be judged. Write them or change the match rule.",
      };
    }
    const lower = output.toLowerCase();
    const missing = facts.filter((f) => !lower.includes(f.toLowerCase()));
    return missing.length === 0
      ? { ok: true, reason: `All ${facts.length} key facts present.` }
      : { ok: false, reason: `Missing key fact(s): ${missing.join("; ")}` };
  }

  // length_limit: the point is to catch an answer cut off by a cap.
  const field = rule.required_final_field;
  const ok = output.toLowerCase().includes(field.toLowerCase());
  return {
    ok,
    reason: ok
      ? `Final field "${field}" is present, so the answer was not cut off.`
      : `Final field "${field}" is missing. The limit truncated the answer.`,
  };
}

export interface RunGateOptions {
  threshold?: number;
  modelClass?: ModelClass;
  now?: Date;
}

export async function runGate(
  task: Task,
  change: Change,
  examples: Example[],
  runner: GateRunner,
  config: Config,
  opts: RunGateOptions = {},
): Promise<Verdict> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const modelClass = opts.modelClass ?? config.models.default_assumed_tier;
  const now = opts.now ?? new Date();

  if (examples.length === 0) {
    throw new Error(
      "runGate needs at least one example. With no examples a change cannot be called safe, and it must be labelled 'not checked against examples' instead.",
    );
  }

  const failures: GateFailure[] = [];
  let passes = 0;
  const spend: TokenCounts = { input: 0, cache_write: 0, cache_read: 0, output: 0, reasoning: 0 };

  for (const example of examples) {
    const result = await runner({ task, change, example, modelClass });
    spend.input += result.tokens.input;
    spend.cache_write += result.tokens.cache_write;
    spend.cache_read += result.tokens.cache_read;
    spend.output += result.tokens.output;
    spend.reasoning += result.tokens.reasoning;

    const verdict = matches(task, example, result.output);
    if (verdict.ok) {
      passes++;
    } else {
      failures.push({
        example_id: example.id,
        reason: verdict.reason,
        expected: example.expected,
        got: result.output,
      });
    }
  }

  const passRate = passes / examples.length;
  const expires = new Date(now.getTime() + VERDICT_TTL_DAYS * 24 * 60 * 60 * 1000);

  return {
    task_id: task.id,
    change_type: change.type,
    change_value: change.value,
    model_class: modelClass,
    example_set_hash: exampleSetHash(examples),
    examples_run: examples.length,
    passes,
    pass_rate: passRate,
    threshold,
    passed: passRate >= threshold,
    checked_at: now.toISOString(),
    expires_at: expires.toISOString(),
    failures,
    check_cost: {
      tokens: outputTokens(spend) + spend.input + spend.cache_read + spend.cache_write,
      energyWh: checkEnergy(spend, modelClass, config),
    },
    runner_kind: (runner as { runnerKind?: "recorded" | "live" }).runnerKind ?? "live",
  };
}

function checkEnergy(spend: TokenCounts, modelClass: ModelClass, config: Config): Range {
  const c = newCollector();
  const eOut = outputEnergyPerToken(config.sources, modelClass, c);
  return scaleRange(eOut, outputTokens(spend), "Wh");
}

/**
 * A runner backed by captured outputs instead of live calls.
 *
 * This is what the demo uses, and the verdict it produces is tagged
 * `runner_kind: "recorded"` so the UI can label it. A seeded gate run shown as
 * a live one would be the single most dishonest thing this product could do, so
 * the tag is not optional and the UI must print it.
 *
 * A live runner is plan item T2-e.
 */
export function recordedRunner(
  records: Record<string, { output: string; tokens: TokenCounts }>,
): GateRunner {
  const runner: GateRunner & { runnerKind?: "recorded" } = async ({ example, change }) => {
    const key = `${change.type}:${change.value}:${example.id}`;
    const hit = records[key] ?? records[example.id];
    if (!hit) {
      throw new Error(
        `recordedRunner has no captured output for "${key}". Capture it, or run the gate live.`,
      );
    }
    return hit;
  };
  runner.runnerKind = "recorded";
  return runner;
}

export function isVerdictStale(verdict: Verdict, examples: Example[], now = new Date()): string | null {
  if (new Date(verdict.expires_at) < now) return "This check has expired. Run it again.";
  if (verdict.example_set_hash !== exampleSetHash(examples)) {
    return "The example set changed since this check ran. Run it again.";
  }
  return null;
}

/** Savings minus what the check itself cost, per plan section 8.3. */
export function netOfCheck(grossWh: Range, verdict: Verdict): Range {
  return {
    low: grossWh.low - verdict.check_cost.energyWh.high,
    high: grossWh.high - verdict.check_cost.energyWh.low,
    unit: grossWh.unit,
  };
}
