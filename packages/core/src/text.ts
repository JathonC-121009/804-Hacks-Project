// Text utilities shared by the detectors and the rewriter.
// Everything here is pure and offset-preserving: the UI highlights spans by
// character offset, so a helper that loses offsets is useless to it.

export interface Span {
  text: string;
  start: number;
  end: number;
}

/**
 * Split into sentences, keeping character offsets.
 * Deliberately simple: a full sentence tokenizer is not worth the risk here.
 * Known limits: abbreviations like "e.g." split, and so do decimals in some
 * positions. Both only affect span boundaries, not whether a flag fires.
 */
export function splitSentences(text: string): Span[] {
  const out: Span[] = [];
  // Break after . ! ? followed by whitespace, and on blank lines.
  const re = /[^.!?\n]*(?:[.!?]+|\n{2,}|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (raw.length === 0) {
      re.lastIndex++;
      if (re.lastIndex > text.length) break;
      continue;
    }
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      const start = m.index + leading;
      out.push({ text: trimmed, start, end: start + trimmed.length });
    }
    if (re.lastIndex >= text.length) break;
  }
  return out;
}

/** Lowercased word tokens with punctuation stripped. Used for all overlap maths. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

export function countWords(text: string): number {
  return words(text).length;
}

/** Word-level n-grams as joined strings. */
export function ngrams(tokens: string[], n: number): string[] {
  if (tokens.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i++) {
    out.push(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

/** Fraction of `a`'s n-grams that also appear in `b`. 0 when `a` is too short. */
export function ngramOverlap(a: string, b: string, n: number): number {
  const aGrams = ngrams(words(a), n);
  if (aGrams.length === 0) return 0;
  const bSet = new Set(ngrams(words(b), n));
  if (bSet.size === 0) return 0;
  let hits = 0;
  for (const g of aGrams) if (bSet.has(g)) hits++;
  return hits / aGrams.length;
}

/**
 * Length, in words, of the longest run of words that `a` and `b` share
 * contiguously.
 *
 * This catches quoting that an n-gram ratio misses. A reply can open with eight
 * consecutive words lifted from the prompt and still score under 0.5 on
 * 5-gram overlap, because its own trailing words dilute the ratio. The run
 * length does not dilute, and a six-word exact run is near-impossible by
 * chance, so it stays a high-precision signal.
 */
export function longestCommonRun(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (A.length === 0 || B.length === 0) return 0;

  // Rolling two-row DP for the classic longest-common-substring problem.
  let prev = new Array<number>(B.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= A.length; i++) {
    const cur = new Array<number>(B.length + 1).fill(0);
    for (let j = 1; j <= B.length; j++) {
      if (A[i - 1] === B[j - 1]) {
        cur[j] = (prev[j - 1] ?? 0) + 1;
        if (cur[j]! > best) best = cur[j]!;
      }
    }
    prev = cur;
  }
  return best;
}

/** Jaccard similarity over word sets. Used to spot repeated instructions. */
export function jaccard(a: string, b: string): number {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Collapse whitespace and case, for comparing sentences for equality. */
export function normalize(text: string): string {
  return words(text).join(" ");
}

export interface Interval {
  start: number;
  end: number;
}

/**
 * Merge overlapping or touching intervals.
 * This is what keeps the efficiency score honest: echo and repetition often
 * cover the same words, and counting them twice would inflate waste.
 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: Interval[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = out[out.length - 1]!;
    if (cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/** djb2. Not cryptographic: it only has to detect that an example set changed. */
export function stableHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
