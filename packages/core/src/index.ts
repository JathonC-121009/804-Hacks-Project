import type {
  AnalysisResult,
  Config,
  Estimate,
  Flag,
  GridData,
  InstructionBlock,
  ModelClass,
  ModelSuggestion,
  RewriteResult,
  TokenCounts,
  TokenSource,
  UsageEvent,
  WasteProfile,
} from "./types.ts";
import { analyze } from "./detect.ts";
import { auditConfig, newCollector, type ConfigWarning } from "./config.ts";
import { estimate } from "./estimate.ts";
import { buildInstructionBlock } from "./instructions.ts";
import { rewritePrompt } from "./rewrite.ts";
import { footprintDeltaForResponse, suggestModel } from "./suggestModel.ts";
import { intensityForHour, type IntensityLookup } from "./grid.ts";
import { estimateTokens } from "./tokens.ts";

export * from "./types.ts";
export { analyze, detect } from "./detect.ts";
export {
  auditConfig,
  emissionFactorBasis,
  emissionFactors,
  newCollector,
  UnsourcedValueError,
  type ConfigWarning,
  type ProvenanceCollector,
} from "./config.ts";
export { energyDeltaPer1kOutput, estimate } from "./estimate.ts";
export { buildInstructionBlock, INSTRUCTION_CAVEATS } from "./instructions.ts";
export { detectTaskType, REWRITE_CAVEATS, rewritePrompt, type RewriteOptions } from "./rewrite.ts";
export { footprintDeltaForResponse, suggestModel } from "./suggestModel.ts";
export {
  exampleSetHash,
  GATE_DEFAULTS,
  isVerdictStale,
  matches,
  netOfCheck,
  recordedRunner,
  runGate,
} from "./gate.ts";
export {
  cleanestHour,
  dirtiestHour,
  emptyGrid,
  fuelMixToIntensity,
  intensityForHour,
  mapFuelCode,
  midpoint,
  parseGridData,
  type IntensityLookup,
} from "./grid.ts";
export { DEFAULT_BASELINE, describeBaseline, efficiencyOf, weeklyCard, wastedTokensOf } from "./card.ts";
export { emptyTokenCounts, estimateTokens, outputTokens, totalTokens } from "./tokens.ts";
export { countWords, mergeIntervals, splitSentences, stableHash } from "./text.ts";

/**
 * One call that produces everything the paste-in analyzer shows.
 *
 * Deliberately a single entry point: the demo has one chance to run, and a
 * sequence of five calls in the UI layer is five places for the order to drift
 * between the portal, the tests and the extension.
 */
export interface FullAnalysisInput {
  prompt: string;
  response: string;
  modelClass: ModelClass;
  /** Real token counts when the surface has them. Omit for text-mode estimates. */
  tokens?: TokenCounts;
  tokenSource?: TokenSource;
  grid?: GridData | null;
  pricePerOutputToken?: number;
  /** Flags from this user's earlier responses, so the block reflects habits. */
  history?: Flag[];
  assumedCurrentTier?: ModelClass;
  timestamp?: string;
  /** True only when a gate verdict exists for this prompt's task. */
  checkedAgainstExamples?: boolean;
}

export interface FullAnalysis {
  event: UsageEvent;
  analysis: AnalysisResult;
  estimate: Estimate;
  instructionBlock: InstructionBlock;
  rewrite: RewriteResult;
  suggestion: ModelSuggestion;
  suggestionDeltaForThisResponse: ReturnType<typeof footprintDeltaForResponse>;
  grid: IntensityLookup;
  /** Everything that must be fixed before this is shown to judges. */
  configWarnings: ConfigWarning[];
}

/**
 * Flags -> wasted tokens per waste type.
 *
 * Advisory flags count here even though they never move the efficiency score:
 * a recap is worth telling the model to stop producing, it just is not
 * something we are willing to score someone on.
 */
export function wasteProfileOf(flags: Flag[]): WasteProfile {
  const profile: WasteProfile = {};
  for (const f of flags) {
    profile[f.type] = (profile[f.type] ?? 0) + (f.tokens > 0 ? f.tokens : 1);
  }
  return profile;
}

export function runFullAnalysis(input: FullAnalysisInput, config: Config): FullAnalysis {
  const timestamp = input.timestamp ?? new Date().toISOString();

  const tokens: TokenCounts =
    input.tokens ??
    {
      input: estimateTokens(input.prompt).tokens,
      cache_write: 0,
      cache_read: 0,
      output: estimateTokens(input.response).tokens,
      reasoning: 0,
    };

  const analysis = analyze(input.response, input.prompt, {
    ...(input.tokens ? { tokens: input.tokens } : {}),
    ...(input.tokenSource ? { tokenSource: input.tokenSource } : {}),
  });

  const event: UsageEvent = {
    id: `evt_${timestamp}`,
    timestamp,
    surface: "paste",
    tool: "other",
    model: input.modelClass,
    model_class: input.modelClass,
    tokens,
    token_source: analysis.tokenSource,
    flags: analysis.flags,
    region: "PJM",
  };

  const collector = newCollector();
  const grid = intensityForHour(input.grid ?? null, timestamp, config.sources, collector);

  const est = estimate(event, config, {
    gridIntensity: grid.intensity,
    gridSource: grid.source,
    ...(input.pricePerOutputToken !== undefined
      ? { pricePerOutputToken: input.pricePerOutputToken }
      : {}),
    wastedOutputTokens: analysis.wastedOutputTokens,
  });

  const instructionBlock = buildInstructionBlock(analysis.flags, input.history ?? []);
  const rewrite = rewritePrompt(input.prompt, undefined, {
    checkedAgainstExamples: input.checkedAgainstExamples ?? false,
    // The same waste that drives the instruction block drives the directions,
    // so the two fixes on screen never tell the user different things.
    wasteProfile: wasteProfileOf([...analysis.flags, ...(input.history ?? [])]),
  });
  const suggestion = suggestModel(input.prompt, config, input.assumedCurrentTier);

  return {
    event,
    analysis,
    estimate: est,
    instructionBlock,
    rewrite,
    suggestion,
    suggestionDeltaForThisResponse: footprintDeltaForResponse(
      suggestion,
      analysis.totalOutputTokens,
    ),
    grid,
    configWarnings: auditConfig(config),
  };
}
