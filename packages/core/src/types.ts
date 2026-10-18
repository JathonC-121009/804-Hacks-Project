// Shared types. This module has no runtime exports on purpose, so every import
// of it must be `import type { ... }`. Node strips types rather than compiling
// them, so a value-style import of a type name would fail at runtime.

/** A low-to-high estimate. Nothing in this product reports a bare number. */
export interface Range {
  low: number;
  high: number;
  unit: string;
}

/** One entry in config/sources.json. */
export interface SourceEntry {
  low: number | null;
  high: number | null;
  unit: string;
  source: string;
  date?: string | null;
  verified: boolean;
  note?: string;
}

export interface SourcesConfig {
  _meta: Record<string, string>;
  e_out_small: SourceEntry;
  e_out_medium: SourceEntry;
  e_out_large: SourceEntry;
  e_in: SourceEntry;
  e_cache_read: SourceEntry;
  e_cache_write: SourceEntry;
  WI: SourceEntry;
  grid_fallback: SourceEntry;
  EF: Record<string, SourceEntry | string>;
  va_dc: SourceEntry;
  ACL2025: SourceEntry;
}

export type ModelClass = "small" | "medium" | "large";

export interface ModelTier {
  id: ModelClass;
  label: string;
  energy_key: "e_out_small" | "e_out_medium" | "e_out_large";
  description: string;
  examples: string[];
  verified: boolean;
}

export interface PlatformTier {
  model: string;
  effort: string;
  /** True only when the model name was checked against that provider's own list. */
  verified: boolean;
  /** True only when the effort value was checked against that provider's docs. */
  effort_verified: boolean;
  note: string;
}

export interface PlatformModels {
  id: string;
  label: string;
  tiers: Record<ModelClass, PlatformTier>;
}

export interface ModelsConfig {
  platforms: PlatformModels[];
  _meta: Record<string, string>;
  tiers: ModelTier[];
  default_assumed_tier: ModelClass;
  default_assumed_tier_note: string;
}

export interface Config {
  sources: SourcesConfig;
  models: ModelsConfig;
}

// --- usage events -----------------------------------------------------------

export interface TokenCounts {
  input: number;
  cache_write: number;
  cache_read: number;
  output: number;
  reasoning: number;
}

export type TokenSource = "user_entered" | "estimated" | "exact";
export type Surface = "paste" | "web" | "cli";

export type FlagType =
  | "echo"
  | "filler"
  | "repetition"
  | "recap"
  | "boilerplate"
  | "overlength"
  | "prompt_side";

/** high = counts toward the efficiency score. advisory = shown, never scored. */
export type Confidence = "high" | "advisory";

export interface Flag {
  type: FlagType;
  confidence: Confidence;
  /** Estimated tokens inside the flagged span. 0 for whole-response advisories. */
  tokens: number;
  /** Character offsets into the text the flag was found in. */
  start: number;
  end: number;
  excerpt: string;
  why: string;
}

export interface UsageEvent {
  id: string;
  timestamp: string;
  surface: Surface;
  tool: string;
  model: string;
  model_class: ModelClass;
  tokens: TokenCounts;
  token_source: TokenSource;
  flags: Flag[];
  region: string;
}

// --- analysis ---------------------------------------------------------------

export interface AnalysisResult {
  flags: Flag[];
  /** Flags found in the prompt. Always advisory. */
  promptFlags: Flag[];
  /** Merged span total, so overlapping detectors never double count. */
  wastedOutputTokens: number;
  totalOutputTokens: number;
  /** 1 - wasted/total. Independent of every energy constant. */
  efficiency: number;
  tokenSource: TokenSource;
  /** What the score did and did not measure, so 100% is never a silent claim. */
  coverage: { lengthTargetWords: number | null; note: string };
}

// --- estimates --------------------------------------------------------------

export interface ResourceSet {
  energyWh: Range;
  waterMl: Range;
  co2g: Range;
  cost: Range;
}

/**
 * Where an hourly carbon figure came from.
 *   eia      - a real row from a live API call
 *   seeded   - a realistic row generated for the demo, never from the API
 *   fallback - the single constant from config, used when nothing else fits
 *
 * `seeded` exists so demo data never has to pose as real data. Without it the
 * only way to get hour-by-hour variation in a demo is to label generated rows
 * "eia", which is precisely the kind of quiet overclaim this product is
 * supposed to catch.
 */
export type GridRowSource = "eia" | "seeded" | "fallback";

export interface Provenance {
  /** Source keys used that are not yet verified. Drives the UI's amber badges. */
  unverified: string[];
  /** Plain-language assumptions to show next to the numbers. */
  assumptions: string[];
  gridSource: GridRowSource;
}

export interface Estimate extends ResourceSet {
  wasted: ResourceSet;
  provenance: Provenance;
}

// --- grid -------------------------------------------------------------------

export interface GridHour {
  /** ISO hour, e.g. 2026-10-18T14:00:00Z */
  hour: string;
  intensity_gco2_per_kwh: Range;
  source: GridRowSource;
  fuel_mix_mwh?: Record<string, number>;
}

export interface GridData {
  region: string;
  fetched_at: string | null;
  hours: GridHour[];
  /** True when this file was written by a real API call rather than seeded. */
  from_live_api: boolean;
  note: string;
}

// --- quality gate -----------------------------------------------------------

export type MatchRule =
  | { kind: "exact" }
  | { kind: "key_facts" }
  | { kind: "length_limit"; required_final_field: string };

export interface Example {
  id: string;
  input: string;
  expected: string;
  /** Required for match rule key_facts. Written by hand, per example. */
  key_facts?: string[];
}

export interface Task {
  id: string;
  name: string;
  task_type: TaskType;
  match_rule: MatchRule;
  baseline_prompt: string;
}

export type ChangeType = "prompt_rewrite" | "input_limit" | "model_tier";

export interface Change {
  type: ChangeType;
  value: string;
  description: string;
}

export interface GateFailure {
  example_id: string;
  reason: string;
  expected: string;
  got: string;
}

export interface Verdict {
  task_id: string;
  change_type: ChangeType;
  change_value: string;
  model_class: ModelClass;
  example_set_hash: string;
  examples_run: number;
  passes: number;
  pass_rate: number;
  threshold: number;
  passed: boolean;
  checked_at: string;
  expires_at: string;
  failures: GateFailure[];
  /** The gate's own cost, subtracted from reported savings (net-of-check). */
  check_cost: { tokens: number; energyWh: Range };
  /** "recorded" must be surfaced in the UI so a seeded run is never passed off as live. */
  runner_kind: "recorded" | "live";
}

export interface GateRunnerArgs {
  task: Task;
  change: Change;
  example: Example;
  modelClass: ModelClass;
}

export type GateRunner = (
  args: GateRunnerArgs,
) => Promise<{ output: string; tokens: TokenCounts }>;

// --- rewrite ----------------------------------------------------------------

export type TaskType =
  | "classify"
  | "extract"
  | "translate"
  | "summarize"
  | "rewrite"
  | "code"
  | "reasoning"
  | "general";

export type DiffOp = { op: "keep" | "remove" | "add"; text: string };

/**
 * Wasted tokens seen so far, by waste type.
 *
 * Passed into a rewrite so the directions it appends match the waste this user
 * actually gets, instead of the same generic line every time. Counts only: no
 * prompt or response text is involved, so this can be stored and shared.
 */
export type WasteProfile = Partial<Record<FlagType, number>>;

export interface Removal {
  text: string;
  why: string;
}

export interface RewriteResult {
  original: string;
  rewritten: string;
  taskType: TaskType;
  diff: DiffOp[];
  tokenDelta: number;
  removed: Removal[];
  added: string[];
  /** Long pasted blocks. Never removed automatically: the user confirms. */
  flaggedContext: { start: number; end: number; excerpt: string; words: number }[];
  /** Set when no saved examples exist for the task, per plan section 5.4. */
  checkedAgainstExamples: boolean;
}

// --- model suggestion -------------------------------------------------------

export interface Signal {
  name: string;
  weight: number;
  hit: boolean;
  detail?: string;
}

export interface PlatformRecommendation {
  platform: string;
  platformId: string;
  model: string;
  effort: string;
  verified: boolean;
  effortVerified: boolean;
  note: string;
}

export interface ModelSuggestion {
  assumedCurrentTier: ModelClass;
  suggestedTier: ModelClass;
  isDowngrade: boolean;
  confidence: "low" | "medium" | "high";
  score: number;
  signals: Signal[];
  /** Per 1000 output tokens, so no output length has to be invented. */
  footprintDeltaPer1kOutput: Range;
  /** Only present when real output token counts are known. */
  footprintDeltaForThisResponse?: Range;
  label: string;
  /** The concrete model and effort per platform, for the suggested tier. */
  recommendations: PlatformRecommendation[];
  caveats: string[];
  /** Always false. The product never switches models. */
  applied: false;
}

// --- instruction block ------------------------------------------------------

export interface InstructionBlock {
  lines: string[];
  block: string;
  wordCount: number;
  basedOn: { type: FlagType; tokens: number }[];
}

// --- weekly card ------------------------------------------------------------

export type Baseline =
  | { kind: "first_days"; days: number }
  | { kind: "first_n"; n: number };

export interface CardData {
  efficiency: number;
  baselineEfficiency: number | null;
  changePoints: number | null;
  wastedTokens: number;
  topWasteType: FlagType | null;
  eventsCounted: number;
  resources: ResourceSet;
  baseline: Baseline;
  baselineLabel: string;
  periodStart: string | null;
  periodEnd: string | null;
  provenance: Provenance;
  isDemoData: boolean;
}
