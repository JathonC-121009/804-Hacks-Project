import type { Config, ModelClass, ModelSuggestion, PlatformRecommendation, Range, Signal } from "./types.ts";
import { countWords } from "./text.ts";
import { energyDeltaPer1kOutput } from "./estimate.ts";

/**
 * Model suggestion (plan section 5.5).
 *
 * Suggestion only. This function returns an object and has no side effects:
 * there is no code path anywhere in this product that switches a model. That is
 * decision 13 in the plan, and it is also the honest answer to the judges'
 * question "why not just route it for them" - we cannot verify from a prompt
 * alone that a smaller model is good enough, so the person decides.
 *
 * The heuristic is deliberately transparent. Every signal that fired is
 * returned with its weight so the UI can show the reasoning, rather than
 * producing a confident-looking tier out of a black box.
 */

const SIGNALS: { name: string; weight: number; test: (p: string, words: number) => boolean; detail?: string }[] = [
  {
    name: "Contains a code block",
    weight: 3,
    test: (p) => /```/.test(p),
    detail: "Code work usually needs a stronger model.",
  },
  {
    name: "Maths or proof",
    weight: 2,
    test: (p) => /\b(?:prove|derive|theorem|integral|derivative|eigen|modulo)\b/i.test(p) || /[∑∫√≤≥≠]/.test(p),
  },
  {
    name: "Asks for multi-step reasoning",
    weight: 2,
    test: (p) => /\b(?:step by step|reason through|think through|analy[sz]e|trade-?offs?|design (?:a|an|the)|architect)\b/i.test(p),
  },
  {
    name: "Long prompt (over 300 words)",
    weight: 2,
    test: (_p, words) => words > 300,
    detail: "A lot of context to hold together.",
  },
  {
    name: "Several questions at once",
    weight: 1,
    test: (p) => (p.match(/\?/g) ?? []).length >= 3,
  },
  {
    name: "Debugging an error",
    weight: 2,
    test: (p) => /\b(?:stack trace|traceback|segfault|TypeError|SyntaxError|NullPointer|exception)\b/.test(p),
  },
  {
    name: "Mechanical language task",
    weight: -2,
    test: (p) => /\b(?:translate|classif|categori[sz]e|extract|reformat|format this|fix (?:the )?(?:grammar|spelling|typos)|proofread|tl;?dr)\b/i.test(p),
    detail: "Small models handle these well.",
  },
  {
    name: "Short, single question",
    weight: -2,
    test: (p, words) => words < 25 && (p.match(/[.!?]/g) ?? []).length <= 1,
  },
  {
    name: "Asks for a simple lookup or definition",
    weight: -1,
    test: (p) => /\b(?:what is|what'?s|define|who is|when (?:was|did)|how do you spell)\b/i.test(p),
  },
];

function tierFor(score: number): ModelClass {
  if (score <= 0) return "small";
  if (score <= 3) return "medium";
  return "large";
}

/** Confidence from distance to the nearest tier boundary. Boundaries are 0/1 and 3/4. */
function confidenceFor(score: number): "low" | "medium" | "high" {
  const distance = Math.min(Math.abs(score - 0.5), Math.abs(score - 3.5));
  if (distance >= 2) return "high";
  if (distance >= 1) return "medium";
  return "low";
}

const ORDER: ModelClass[] = ["small", "medium", "large"];

/** The concrete model and effort each AI tool would use for this tier. */
export function recommendationsFor(config: Config, tier: ModelClass): PlatformRecommendation[] {
  return config.models.platforms.map((platform) => {
    const pick = platform.tiers[tier];
    return {
      platform: platform.label,
      platformId: platform.id,
      model: pick.model,
      effort: pick.effort,
      verified: pick.verified,
      effortVerified: pick.effort_verified,
      note: pick.note,
    };
  });
}

export function suggestModel(
  prompt: string,
  config: Config,
  assumedCurrentTier?: ModelClass,
): ModelSuggestion {
  const words = countWords(prompt);
  const signals: Signal[] = SIGNALS.map((s) => {
    const hit = s.test(prompt, words);
    const base: Signal = { name: s.name, weight: s.weight, hit };
    return s.detail ? { ...base, detail: s.detail } : base;
  });

  const score = signals.filter((s) => s.hit).reduce((sum, s) => sum + s.weight, 0);
  const suggestedTier = tierFor(score);
  const current = assumedCurrentTier ?? config.models.default_assumed_tier;
  const isDowngrade = ORDER.indexOf(suggestedTier) < ORDER.indexOf(current);

  const delta = energyDeltaPer1kOutput(config, current, suggestedTier);

  const caveats = [
    "This is a heuristic read of your prompt, not a test of the answer.",
    "If the smaller model gets it wrong you will retry, and two attempts can cost more than one good one.",
    "We never switch your model. This is a suggestion you can ignore.",
  ];
  if (!isDowngrade) {
    caveats.unshift("No saving available here: this prompt looks like it needs the model you are already on.");
  }

  const confidence = confidenceFor(score);
  if (confidence === "low") {
    caveats.unshift("Low confidence: this prompt sits close to the line between tiers.");
  }

  const recommendations = recommendationsFor(config, suggestedTier);
  const claude = recommendations.find((r) => r.platformId === "claude") ?? recommendations[0];
  const label = isDowngrade && claude
    ? `${claude.model} at ${claude.effort} effort is likely enough`
    : `Stay on your current model`;

  return {
    assumedCurrentTier: current,
    suggestedTier,
    isDowngrade,
    confidence,
    score,
    signals,
    footprintDeltaPer1kOutput: delta.range,
    label,
    recommendations,
    caveats,
    applied: false,
  };
}

/** Letters and digits only, so "GPT-6 Luna" and "gpt-6-luna" compare equal. */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Work out which tier a model name belongs to, from config alone.
 *
 * Matches the configured model ids first, then the human names in each tier's
 * examples, so a picker reading "Claude Haiku 5.5" lands on the same tier as
 * the id "claude-haiku-5-5". Returns null rather than guessing: an unknown
 * name means the site renamed something, and inventing a tier would produce a
 * confident, wrong recommendation.
 */
export function classifyModelName(
  name: string,
  config: Config,
): { platformId: string; tier: ModelClass } | null {
  const needle = squash(name);
  if (needle.length < 3) return null;
  for (const platform of config.models.platforms) {
    for (const tier of ["large", "medium", "small"] as ModelClass[]) {
      const id = squash(platform.tiers[tier].model);
      if (id.length < 3) continue;
      // Both directions: a picker may show the full id ("claude-opus-5-5") or
      // just the part people say out loud ("Opus 5.5").
      if (needle.includes(id) || (needle.length >= 5 && id.includes(needle))) {
        return { platformId: platform.id, tier };
      }
    }
  }
  for (const tier of config.models.tiers) {
    for (const example of tier.examples) {
      const ex = squash(example);
      if (ex.length >= 3 && needle.includes(ex)) return { platformId: "", tier: tier.id };
    }
  }
  return null;
}

/** Same suggestion, plus the saving for one known response length. */
export function footprintDeltaForResponse(
  suggestion: ModelSuggestion,
  outputTokens: number,
): Range {
  const per1k = suggestion.footprintDeltaPer1kOutput;
  const factor = outputTokens / 1000;
  return {
    low: per1k.low * factor,
    high: per1k.high * factor,
    unit: "Wh",
  };
}
