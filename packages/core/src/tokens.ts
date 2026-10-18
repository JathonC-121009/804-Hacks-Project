import type { TokenCounts } from "./types.ts";
import { countWords } from "./text.ts";

/**
 * Token counting (plan section 6.1).
 *
 * Accuracy by surface:
 *   user_entered / exact -> real counts, nothing estimated here
 *   estimated            -> this heuristic, shown as a range
 *
 * The heuristic runs two cheap approximations and keeps both ends:
 *   words x 1.3   and   characters / 4
 * Neither is right; the spread between them is the honest uncertainty, which is
 * why callers get low/high rather than one number.
 *
 * Plan rule: never call a network tokenizer. That would break the local-only
 * promise, which is a selling point and a privacy commitment.
 *
 * TODO before the pitch (plan section 20): calibrate against a real local
 * tokenizer on the 20 fixtures and record the error here.
 */
export interface TokenEstimate {
  /** Mid-point, for arithmetic that needs a single number. */
  tokens: number;
  low: number;
  high: number;
  method: "words_x_1.3 and chars_div_4";
}

const WORDS_TO_TOKENS = 1.3;
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): TokenEstimate {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { tokens: 0, low: 0, high: 0, method: "words_x_1.3 and chars_div_4" };
  }
  const byWords = countWords(trimmed) * WORDS_TO_TOKENS;
  const byChars = trimmed.length / CHARS_PER_TOKEN;
  const low = Math.max(1, Math.floor(Math.min(byWords, byChars)));
  const high = Math.max(low, Math.ceil(Math.max(byWords, byChars)));
  return {
    tokens: Math.round((low + high) / 2),
    low,
    high,
    method: "words_x_1.3 and chars_div_4",
  };
}

export function emptyTokenCounts(): TokenCounts {
  return { input: 0, cache_write: 0, cache_read: 0, output: 0, reasoning: 0 };
}

/**
 * Billable output tokens. Reasoning tokens are billed as output and are the
 * expensive ones, so they belong here (plan section 6.2). On web chat they are
 * hidden, which means output is undercounted; the UI has to say so.
 */
export function outputTokens(t: TokenCounts): number {
  return t.output + t.reasoning;
}

export function totalTokens(t: TokenCounts): number {
  return t.input + t.cache_write + t.cache_read + t.output + t.reasoning;
}
