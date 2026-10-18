import type {
  AnalysisResult,
  Flag,
  FlagType,
  TokenCounts,
  TokenSource,
} from "./types.ts";
import {
  countWords,
  jaccard,
  longestCommonRun,
  mergeIntervals,
  ngramOverlap,
  normalize,
  splitSentences,
  type Span,
} from "./text.ts";
import { estimateTokens, outputTokens } from "./tokens.ts";

/**
 * Output-waste detection (plan section 5.2).
 *
 * Design rule, from the plan's risk table: favour precision over recall. A
 * false positive tells the user their good writing is waste, which destroys
 * trust in every other number on the page. Missing some waste only understates
 * the score. So each scored detector needs strong evidence, and anything fuzzy
 * is `advisory` and never touches the efficiency figure.
 *
 * Scored (confidence "high"):   echo, filler, repetition
 * Advisory (never scored):      recap, boilerplate, overlength, prompt_side
 */

// --- echo -------------------------------------------------------------------

/** Phrases that restate the question. Near-certain echo when they open a reply. */
const ECHO_PHRASES: RegExp[] = [
  /\byou (?:asked|wanted to know|are asking|'re asking)\b/i,
  /\byour question\b/i,
  /\bto answer your question\b/i,
  /\bas you (?:mentioned|noted|said|pointed out)\b/i,
  /\byou mentioned that\b/i,
  /\blet me restate\b/i,
  /\brestating your\b/i,
  /\bif I understand (?:you )?correctly\b/i,
  /\bso you want to know\b/i,
  /\bthe question you(?:'ve| have) asked\b/i,
];

/** 5-gram overlap this high between a reply's opening and the prompt is quoting. */
const ECHO_OVERLAP_THRESHOLD = 0.5;
const ECHO_NGRAM = 5;
const ECHO_MIN_WORDS = 8;
/** A contiguous run this long lifted from the prompt is quoting, not coincidence. */
const ECHO_MIN_RUN_WORDS = 6;
/** Echo lives at the start of a reply. Looking further causes false positives. */
const ECHO_WINDOW_SENTENCES = 3;

function detectEcho(sentences: Span[], prompt: string): Flag[] {
  if (prompt.trim().length === 0) return [];
  const flags: Flag[] = [];
  const window = sentences.slice(0, ECHO_WINDOW_SENTENCES);

  for (let i = 0; i < window.length; i++) {
    const s = window[i]!;
    const wordCount = countWords(s.text);

    // Route 1: the reply reuses a large share of the prompt's wording.
    if (wordCount >= ECHO_MIN_WORDS) {
      const overlap = ngramOverlap(s.text, prompt, ECHO_NGRAM);
      if (overlap >= ECHO_OVERLAP_THRESHOLD) {
        flags.push(
          makeFlag("echo", "high", s, `${Math.round(overlap * 100)}% of this sentence's 5-word sequences also appear in your prompt.`),
        );
        continue;
      }

      // Route 1b: a long contiguous lift. The ratio above gets diluted when the
      // sentence adds words of its own, so run length is the better test for
      // "it opened by quoting the question back".
      const run = longestCommonRun(s.text, prompt);
      if (run >= ECHO_MIN_RUN_WORDS) {
        flags.push(
          makeFlag("echo", "high", s, `Repeats ${run} words of your prompt back in a row before answering.`),
        );
        continue;
      }
    }

    // Route 2: a restating phrase in the first two sentences. Catches
    // paraphrased echo, which the wording-based routes miss.
    if (i < 2 && wordCount >= 6) {
      const hit = ECHO_PHRASES.find((re) => re.test(s.text));
      if (hit) {
        flags.push(makeFlag("echo", "high", s, "Opens by referring back to the question instead of answering it."));
      }
    }
  }
  return flags;
}

// --- filler -----------------------------------------------------------------

const FILLER_OPENERS: RegExp[] = [
  /^(?:great|good|excellent|interesting|fantastic|wonderful|nice)\s+(?:question|point)\b/i,
  /^(?:that'?s|what)\s+(?:a\s+)?(?:really\s+)?(?:great|good|excellent|interesting)\s+(?:question|point)\b/i,
  /^(?:certainly|sure|of course|absolutely|definitely|got it|understood|indeed)\b[!,.\s]/i,
  /^(?:certainly|sure|of course|absolutely|definitely|got it|understood)[!.]?$/i,
  /^i'?d be happy to\b/i,
  /^(?:happy|glad) to help\b/i,
  /^thanks? (?:for|you for) (?:asking|the question|your question)\b/i,
  /^let'?s (?:dive in|get started|dive right in|jump in)\b/i,
  /^(?:ah|oh|well),?\s/i,
];

const FILLER_CLOSERS: RegExp[] = [
  /\bi hope (?:this|that|these) helps?\b/i,
  /\bhope (?:this|that) helps?\b/i,
  /\blet me know if you\b/i,
  /\bjust let me know\b/i,
  /\bfeel free to (?:ask|reach out|let me know)\b/i,
  /\bdon'?t hesitate to\b/i,
  /\bwould you like me to\b/i,
  /\bif you (?:have|'ve got) any (?:other|further|more)?\s*questions\b/i,
  /\bhappy to (?:help|clarify|elaborate|expand|go deeper)\b/i,
  /\banything else (?:i can|you'?d like|you need)\b/i,
  /\bgood luck\b/i,
];

/** Filler sentences are short. A long sentence that trips a pattern is usually real content. */
const FILLER_MAX_WORDS = 35;
const FILLER_EDGE_SENTENCES = 2;

function detectFiller(sentences: Span[]): Flag[] {
  const flags: Flag[] = [];
  const n = sentences.length;

  for (let i = 0; i < n; i++) {
    const s = sentences[i]!;
    if (countWords(s.text) > FILLER_MAX_WORDS) continue;

    const nearStart = i < FILLER_EDGE_SENTENCES;
    const nearEnd = i >= n - FILLER_EDGE_SENTENCES;

    if (nearStart && FILLER_OPENERS.some((re) => re.test(s.text))) {
      flags.push(makeFlag("filler", "high", s, "Opening pleasantry. Costs output tokens and says nothing."));
      continue;
    }
    if (nearEnd && FILLER_CLOSERS.some((re) => re.test(s.text))) {
      flags.push(makeFlag("filler", "high", s, "Closing pleasantry or offer of more help. Pure overhead."));
    }
  }
  return flags;
}

// --- repetition -------------------------------------------------------------

/** Floor for FUZZY matching: short parallel list items legitimately overlap. */
const REPETITION_MIN_WORDS = 8;
/** Floor for EXACT matching. Lower, because an identical sentence is a repeat
 *  at any real length and needs no protection from coincidence. */
const REPETITION_EXACT_MIN_WORDS = 5;
/** Word-set overlap above this means the same point twice, not two points. */
const REPETITION_JACCARD = 0.85;

function detectRepetition(sentences: Span[]): Flag[] {
  const flags: Flag[] = [];
  const seen: string[] = [];

  for (const s of sentences) {
    const wordCount = countWords(s.text);
    if (wordCount < REPETITION_EXACT_MIN_WORDS) continue;
    const norm = normalize(s.text);

    if (seen.includes(norm)) {
      flags.push(makeFlag("repetition", "high", s, "Word-for-word repeat of an earlier sentence."));
      continue;
    }
    if (
      wordCount >= REPETITION_MIN_WORDS &&
      seen.some((prev) => jaccard(prev, norm) >= REPETITION_JACCARD)
    ) {
      flags.push(makeFlag("repetition", "high", s, "Restates a point already made, in different words."));
      continue;
    }
    seen.push(norm);
  }
  return flags;
}

// --- recap (advisory) -------------------------------------------------------

const RECAP_MARKERS =
  /^(?:in summary|to summarize|to summarise|in conclusion|to conclude|to recap|to sum up|summing up|in short|overall|tl;?dr)\b/i;

/** A recap in the closing third is redundant. Earlier, it may be scaffolding. */
const RECAP_TAIL_FRACTION = 0.6;

function detectRecap(sentences: Span[], response: string): Flag[] {
  const flags: Flag[] = [];
  for (const s of sentences) {
    if (!RECAP_MARKERS.test(s.text)) continue;
    const position = s.start / Math.max(1, response.length);
    if (position < RECAP_TAIL_FRACTION) continue;

    // Flag the marker through the end of its paragraph.
    const paraEnd = findParagraphEnd(response, s.start);
    const end = Math.max(s.end, paraEnd);
    flags.push({
      type: "recap",
      confidence: "advisory",
      tokens: estimateTokens(response.slice(s.start, end)).tokens,
      start: s.start,
      end,
      excerpt: excerpt(response.slice(s.start, end)),
      why: "Repeats what was just said. Advisory only: some recaps are genuinely useful, so this is not scored.",
    });
  }
  return flags;
}

function findParagraphEnd(text: string, from: number): number {
  const idx = text.indexOf("\n\n", from);
  return idx === -1 ? text.length : idx;
}

// --- boilerplate (advisory) -------------------------------------------------

const BOILERPLATE: RegExp[] = [
  /\bas an ai(?:\s+(?:language\s+)?(?:model|assistant))?\b/i,
  /\bi'?m just an ai\b/i,
  /\bi (?:don'?t|do not) have (?:access to )?real-?time\b/i,
  /\bas of my (?:last |knowledge )?(?:update|cutoff|training)\b/i,
  /\bmy training data\b/i,
  /\bi'?m not a (?:lawyer|doctor|financial advisor|medical professional|tax professional)\b/i,
  /\b(?:this|it) is not (?:legal|financial|medical|investment|tax) advice\b/i,
  /\b(?:consult|speak (?:to|with)|see) a (?:qualified |licensed |certified )?(?:professional|lawyer|attorney|doctor|physician|financial advisor|accountant)\b/i,
  /\bi (?:cannot|can'?t) browse the (?:internet|web)\b/i,
];

function detectBoilerplate(sentences: Span[]): Flag[] {
  const flags: Flag[] = [];
  for (const s of sentences) {
    if (BOILERPLATE.some((re) => re.test(s.text))) {
      flags.push({
        type: "boilerplate",
        confidence: "advisory",
        tokens: estimateTokens(s.text).tokens,
        start: s.start,
        end: s.end,
        excerpt: excerpt(s.text),
        why: "Standard disclaimer. Advisory only: sometimes it genuinely matters, so this is not scored.",
      });
    }
  }
  return flags;
}

// --- overlength (advisory) --------------------------------------------------

const OVERLENGTH_PROMPT_MAX_WORDS = 15;
const OVERLENGTH_RATIO = 40;

function detectOverlength(response: string, prompt: string): Flag[] {
  const p = countWords(prompt);
  const r = countWords(response);
  if (p === 0 || p > OVERLENGTH_PROMPT_MAX_WORDS) return [];
  const ratio = r / p;
  if (ratio <= OVERLENGTH_RATIO) return [];
  return [
    {
      type: "overlength",
      confidence: "advisory",
      tokens: 0,
      start: 0,
      end: 0,
      excerpt: "",
      why: `A ${p}-word question produced a ${r}-word answer (${Math.round(ratio)}x). Advisory and unscored: length is not waste by itself, and we cannot tell from text alone how much of it you needed.`,
    },
  ];
}

// --- prompt-side (advisory, found in the prompt) ----------------------------

const POLITENESS: RegExp[] = [
  /\bplease\b/i,
  /\bthank you(?: in advance)?\b/i,
  /\bthanks(?: in advance)?\b/i,
  /\bif you (?:don'?t mind|would be so kind)\b/i,
  /\bi hope you'?re (?:well|doing well)\b/i,
  /\bcould you kindly\b/i,
  /\bi'?d really appreciate it\b/i,
];

const PROMPT_LONG_WORDS = 400;
const PROMPT_DUP_JACCARD = 0.8;

function detectPromptSide(prompt: string): Flag[] {
  if (prompt.trim().length === 0) return [];
  const flags: Flag[] = [];
  const sentences = splitSentences(prompt);
  const total = countWords(prompt);

  if (total > PROMPT_LONG_WORDS) {
    flags.push({
      type: "prompt_side",
      confidence: "advisory",
      tokens: 0,
      start: 0,
      end: 0,
      excerpt: "",
      why: `Long prompt (${total} words). Under the output-centred energy model this costs little energy, but it costs money and usage-limit headroom.`,
    });
  }

  const kept: string[] = [];
  for (const s of sentences) {
    if (countWords(s.text) < 6) continue;
    const norm = normalize(s.text);
    if (kept.some((k) => jaccard(k, norm) >= PROMPT_DUP_JACCARD)) {
      flags.push({
        type: "prompt_side",
        confidence: "advisory",
        tokens: estimateTokens(s.text).tokens,
        start: s.start,
        end: s.end,
        excerpt: excerpt(s.text),
        why: "Repeats an instruction you already gave.",
      });
      continue;
    }
    kept.push(norm);
  }

  for (const s of sentences) {
    if (countWords(s.text) > 25) continue;
    if (POLITENESS.some((re) => re.test(s.text))) {
      flags.push({
        type: "prompt_side",
        confidence: "advisory",
        tokens: estimateTokens(s.text).tokens,
        start: s.start,
        end: s.end,
        excerpt: excerpt(s.text),
        why: "Politeness. Harmless, but it is tokens.",
      });
    }
  }
  return flags;
}

// --- helpers ----------------------------------------------------------------

function makeFlag(type: FlagType, confidence: "high" | "advisory", span: Span, why: string): Flag {
  return {
    type,
    confidence,
    tokens: estimateTokens(span.text).tokens,
    start: span.start,
    end: span.end,
    excerpt: excerpt(span.text),
    why,
  };
}

function excerpt(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

// --- public API -------------------------------------------------------------

export interface DetectResult {
  flags: Flag[];
  promptFlags: Flag[];
}

export function detect(response: string, prompt = ""): DetectResult {
  const sentences = splitSentences(response);
  const flags: Flag[] = [
    ...detectEcho(sentences, prompt),
    ...detectFiller(sentences),
    ...detectRepetition(sentences),
    ...detectRecap(sentences, response),
    ...detectBoilerplate(sentences),
    ...detectOverlength(response, prompt),
  ];
  flags.sort((a, b) => a.start - b.start || a.end - b.end);
  return { flags, promptFlags: detectPromptSide(prompt) };
}

export interface AnalyzeOptions {
  /** Real token counts, when the surface provides them. */
  tokens?: TokenCounts;
  tokenSource?: TokenSource;
}

/**
 * Efficiency % = 1 - wasted output tokens / total output tokens.
 *
 * Two things keep this honest:
 *  - only high-confidence flags count, so advisories never move the score;
 *  - overlapping spans are merged first, because echo and repetition routinely
 *    cover the same words and counting both would inflate waste.
 *
 * Waste is measured as a share of the response's characters and then applied to
 * the total output tokens. That way the score means the same thing whether the
 * token count came from a real usage field or from the text heuristic.
 */
export function analyze(response: string, prompt = "", opts: AnalyzeOptions = {}): AnalysisResult {
  const { flags, promptFlags } = detect(response, prompt);

  const scored = flags.filter((f) => f.confidence === "high" && f.end > f.start);
  const merged = mergeIntervals(scored.map((f) => ({ start: f.start, end: f.end })));
  const wastedChars = merged.reduce((sum, iv) => sum + (iv.end - iv.start), 0);

  const haveRealCounts = opts.tokens !== undefined;
  const total = haveRealCounts ? outputTokens(opts.tokens!) : estimateTokens(response).tokens;
  const responseChars = Math.max(1, response.trim().length);
  const wastedFraction = Math.min(1, wastedChars / responseChars);
  const wastedOutputTokens = Math.round(wastedFraction * total);

  const efficiency = total === 0 ? 1 : Math.max(0, Math.min(1, 1 - wastedOutputTokens / total));

  return {
    flags,
    promptFlags,
    wastedOutputTokens,
    totalOutputTokens: total,
    efficiency,
    tokenSource: opts.tokenSource ?? (haveRealCounts ? "user_entered" : "estimated"),
  };
}
