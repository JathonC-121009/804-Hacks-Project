import type { DiffOp, FlagType, Removal, RewriteResult, TaskType, WasteProfile } from "./types.ts";
import { countWords, jaccard, normalize, splitSentences, words } from "./text.ts";
import { estimateTokens } from "./tokens.ts";
import { hasLengthLimit, isMultiAsk, requestKind, type RequestKind } from "./advice.ts";

/**
 * Per-prompt rewrite (plan section 5.4).
 *
 * Rule-based and local. An LLM rewrite would spend energy to save energy and
 * would send the prompt off the device, breaking the local-only promise. Rules
 * are also auditable: the user can see exactly why each word went.
 *
 * Where the saving actually comes from, stated plainly because the pitch has to
 * say it too: under the output-centred model, trimming input saves very little
 * energy. Most of the energy saving is in the appended output directions. Input
 * trimming saves money and usage-limit headroom.
 *
 * Nothing here is applied automatically. The caller shows the diff and the user
 * approves, because trimming can change meaning.
 */

// --- task type --------------------------------------------------------------

const TASK_PATTERNS: { type: TaskType; patterns: RegExp[] }[] = [
  { type: "classify", patterns: [/\bclassif/i, /\bcategori[sz]/i, /\blabel (?:this|these|the following)\b/i, /\bis this (?:a|an|spam|positive|negative)\b/i, /\bsentiment\b/i] },
  { type: "extract", patterns: [/\bextract\b/i, /\bpull out\b/i, /\bfind all (?:the )?(?:names|dates|emails|numbers|entities)\b/i, /\blist the (?:names|dates|values|fields)\b/i] },
  { type: "translate", patterns: [/\btranslate\b/i, /\binto (?:spanish|french|german|chinese|japanese|korean|portuguese|italian)\b/i] },
  { type: "summarize", patterns: [/\bsummar[iy]/i, /\btl;?dr\b/i, /\bgive me the gist\b/i, /\bkey (?:points|takeaways)\b/i] },
  { type: "rewrite", patterns: [/\brewrite\b/i, /\brephrase\b/i, /\breword\b/i, /\bproofread\b/i, /\bfix (?:the )?(?:grammar|spelling|typos)\b/i, /\bmake this (?:clearer|shorter|more)\b/i] },
  { type: "code", patterns: [/```/, /\bfunction\b/i, /\brefactor\b/i, /\bdebug\b/i, /\bstack trace\b/i, /\bwrite (?:a |some )?(?:code|script|test|query)\b/i, /\bTypeError|SyntaxError|NullPointer/] },
  { type: "reasoning", patterns: [/\bwhy (?:does|do|is|are|would)\b/i, /\bprove\b/i, /\bderive\b/i, /\bcompare .* (?:and|vs\.?|versus)\b/i, /\btrade-?offs?\b/i, /\bdesign (?:a|an|the)\b/i, /\barchitect/i, /\bstep by step\b/i] },
];

export function detectTaskType(prompt: string): TaskType {
  for (const { type, patterns } of TASK_PATTERNS) {
    if (patterns.some((re) => re.test(prompt))) return type;
  }
  return "general";
}

// --- output directions ------------------------------------------------------

/**
 * The directions appended to a prompt. These are where the energy saving is,
 * so they are chosen rather than boilerplate: a generic line the user reads
 * once and stops seeing saves nothing.
 *
 * Three inputs decide them, in this order:
 *   1. the task type       - what shape the answer should take;
 *   2. the prompt itself   - a definition question wants two sentences, a
 *                            prompt with pasted text invites it to be quoted back;
 *   3. the user's waste    - the types their replies actually waste tokens on.
 *
 * Capped at three lines. They are sent as input on every message, so a long
 * block spends tokens forever to save them once.
 */

/**
 * The shape of the answer, per task type.
 *
 * Note `reasoning` deliberately gets no length cap. Capping length on hard
 * reasoning is exactly where brevity costs accuracy, and claiming a saving
 * there would be the kind of overclaim the plan's risk table warns about.
 */
const TASK_DIRECTION: Record<TaskType, string> = {
  classify: "Reply with the label only, nothing else.",
  extract: "Reply with the extracted values only, one per line. No commentary.",
  translate: "Reply with the translation only.",
  summarize: "Reply with at most 5 bullet points. No preamble, no closing line.",
  rewrite: "Reply with the rewritten text only.",
  code: "Reply with the code and at most one line of explanation. No preamble.",
  // No line for these two. "Answer directly." said nothing about the prompt.
  reasoning: "",
  general: "",
};

/**
 * The same directions with their length clause taken out, used when the prompt
 * already states a length. "Reply with at most 5 bullet points" on a prompt
 * that asked for exactly 3 is a contradiction, and the model has to pick one.
 */
const TASK_DIRECTION_NO_LENGTH: Partial<Record<TaskType, string>> = {
  summarize: "No preamble, no closing line.",
  code: "Reply with the code only. No preamble.",
};

/** Task types whose direction says nothing about length, so the prompt may. */
const WEAK_BASE: TaskType[] = ["general", "reasoning"];

const MAX_DIRECTIONS = 3;

/**
 * One line per waste type, matching the standing instruction block in
 * instructions.ts. The two fixes have to agree: a user told one thing before
 * sending and a different thing afterwards stops trusting both.
 */
const WASTE_DIRECTION: { type: FlagType; line: string }[] = [
  { type: "echo", line: "Do not restate my question." },
  { type: "filler", line: "No greeting and no closing offer of more help." },
  { type: "repetition", line: "Do not make the same point twice." },
  { type: "recap", line: "No recap or summary at the end." },
  { type: "boilerplate", line: "Skip standard disclaimers." },
  { type: "overlength", line: "Keep it as short as the question allows." },
];

/**
 * Used when no waste has been recorded yet. Deliberately one compact sentence
 * covering the three commonest wastes: before we know anything about a user,
 * three separate lines would cost more tokens than the guess is worth.
 */

/**
 * The concrete length a plain request should carry, or null when the request
 * should not be capped. Reasoning is never capped, and neither is a multi-part
 * question: one cap over several asks would cut some of them short.
 */
const LENGTH_EDIT: Partial<Record<RequestKind, string>> = {
  explain: "Answer in 3 sentences.",
  write: "Keep it under 150 words.",
  list: "Give 5 bullets.",
  summarize: "Summarize in 3 bullets.",
};

function lengthEditFor(
  prompt: string,
  taskType: TaskType,
  directions: string[],
  withLength: boolean,
): string | null {
  if (!withLength || taskType === "reasoning" || hasLengthLimit(prompt) || isMultiAsk(prompt)) return null;
  // A task direction that already caps length wins. Two limits in one prompt
  // contradict each other and make it longer, which is the opposite of the job.
  if (directions.some((line) => hasLengthLimit(line))) return null;
  return LENGTH_EDIT[requestKind(prompt)] ?? null;
}

/** A length direction the prompt itself earns. Only used when the task type has none. */
function lengthDirectionFor(prompt: string): string | null {
  if (/\b(?:what(?:'s| is)|who(?:'s| is)|define|when (?:was|did)|how do you spell)\b/i.test(prompt)) {
    return "Answer in one or two sentences.";
  }
  if (/\b(?:list|name|give me)\b[^.?!]{0,40}\b(?:\d+|a few|some)\b/i.test(prompt)) {
    return "Bullets only, no introduction.";
  }
  if (/\b(?:yes or no|is it true|should i)\b/i.test(prompt)) {
    return "Start with a one-word answer, then at most two sentences.";
  }
  return null;
}

/**
 * Waste types a task direction already rules out.
 *
 * "Reply with the label only" has said everything "no greeting" would. Saying
 * both wastes input tokens on every message and reads like the repetition this
 * product exists to flag.
 */
const COVERED_BY_TASK: Partial<Record<TaskType, FlagType[]>> = {
  classify: ["echo", "filler", "recap", "boilerplate", "overlength"],
  extract: ["echo", "filler", "recap", "boilerplate", "overlength"],
  translate: ["echo", "filler", "recap", "boilerplate", "overlength"],
  rewrite: ["echo", "filler", "recap", "boilerplate", "overlength"],
  summarize: ["filler", "recap", "overlength"],
  code: ["filler", "recap", "overlength"],
};

/** Waste lines for the types this user wastes most on, heaviest first. */
function wasteDirections(
  profile: WasteProfile | undefined,
  taskType: TaskType,
  limit: number,
): string[] {
  if (!profile || limit <= 0) return [];
  const covered = COVERED_BY_TASK[taskType] ?? [];
  const ranked = WASTE_DIRECTION.filter(
    (w) => (profile[w.type] ?? 0) > 0 && !covered.includes(w.type),
  ).sort((a, b) => (profile[b.type] ?? 0) - (profile[a.type] ?? 0));
  return ranked.slice(0, limit).map((w) => w.line);
}

function chooseDirections(
  prompt: string,
  taskType: TaskType,
  hasPastedContext: boolean,
  profile: WasteProfile | undefined,
): string[] {
  const weak = WEAK_BASE.includes(taskType);
  // Never add a length when the prompt already states one. Two limits in one
  // prompt contradict each other, and the one we invent would override what
  // the person actually asked for.
  const length = weak && !hasLengthLimit(prompt) ? lengthDirectionFor(prompt) : null;

  // A length direction earned by the prompt beats a bare "Answer directly",
  // which it already implies.
  const stated = hasLengthLimit(prompt);
  const base = stated
    ? (TASK_DIRECTION_NO_LENGTH[taskType] ?? (weak ? "" : TASK_DIRECTION[taskType]))
    : TASK_DIRECTION[taskType];
  const lines: string[] = [length ?? base];

  if (hasPastedContext) lines.push("Do not quote the text above back to me.");

  const fromWaste = wasteDirections(profile, taskType, MAX_DIRECTIONS - lines.length);
  if (fromWaste.length > 0) {
    lines.push(...fromWaste);
  }
  // No generic catch-all here. A line that says "no preamble" whatever the
  // prompt is not analysis; the advice module says what this prompt needs.

  return lines.slice(0, MAX_DIRECTIONS);
}

// --- politeness stripping ---------------------------------------------------

/** Phrases removed inside a sentence that still carries the real instruction. */
const PHRASE_STRIPS: { re: RegExp; why: string }[] = [
  { re: /\bi was wondering if you could\s*/gi, why: "Politeness padding." },
  { re: /\bcan you (?:please )?(?=(?:explain|describe|list|write|summari[sz]e|give|tell|compare|draft|suggest)\b)/gi, why: "Question framing: the instruction alone is clearer." },
  { re: /\bcould you (?:please )?(?=(?:explain|describe|list|write|summari[sz]e|give|tell|compare|draft|suggest)\b)/gi, why: "Question framing: the instruction alone is clearer." },
  { re: /\bi would like you to\s*/gi, why: "Filler: the instruction alone is clearer." },
  { re: /\bi need you to\s*/gi, why: "Filler: the instruction alone is clearer." },
  { re: /\bi want you to\s*/gi, why: "Filler: the instruction alone is clearer." },
  { re: /,?\s*thanks in advance\b[!.]?/gi, why: "Pleasantry at the end of a sentence." },
  { re: /,?\s*thank you\b[!.]?/gi, why: "Pleasantry at the end of a sentence." },
  { re: /\b(?:basically|essentially|actually),?\s+/gi, why: "Filler word." },
  { re: /\bcould you (?:please |kindly )?/gi, why: "Politeness: the request is clear without it." },
  { re: /\bwould you (?:please |kindly )?/gi, why: "Politeness: the request is clear without it." },
  { re: /\bi was wondering if you could\s*/gi, why: "Politeness padding." },
  { re: /\bi'?d (?:really )?appreciate it if you could\s*/gi, why: "Politeness padding." },
  { re: /\bif you don'?t mind,?\s*/gi, why: "Politeness padding." },
  { re: /\bplease\s+/gi, why: "Politeness: no effect on the answer." },
  { re: /\s*\bplease\b/gi, why: "Politeness: no effect on the answer." },
];

/** Sentences that are nothing but pleasantry, so the whole sentence goes. */
const PLEASANTRY_SENTENCES: RegExp[] = [
  /^thank(?:s| you)(?: so much)?(?: in advance)?(?: for your help)?[!.\s]*$/i,
  /^i hope (?:you'?re|you are) (?:well|doing well)[!.\s]*$/i,
  /^hope (?:this finds you well|you'?re well)[!.\s]*$/i,
  /^(?:hi|hello|hey)(?: there)?[!,.\s]*$/i,
  /^i'?d (?:really )?appreciate (?:it|your help|any help)[!.\s]*$/i,
  /^no rush[!.\s]*$/i,
];

// --- redundant clauses inside one sentence ----------------------------------

/**
 * Clauses that ask again for what the prompt has already asked for.
 *
 * "Explain how closed loop cooling works, I want to learn about closed loop
 * cooling" says one thing twice, and the sentence-level duplicate check cannot
 * see it because the repeat lives inside the same sentence and shares almost no
 * wording with it once you count the filler verbs.
 *
 * The rule is deliberately narrow: the clause must BOTH open with a phrase that
 * carries no instruction of its own, AND name nothing the prompt has not
 * already named. A clause that introduces any new subject is kept, because at
 * that point it is a second request rather than an echo of the first.
 */
const META_REQUEST =
  /^(?:and\s+|also\s+|plus\s+)?(?:i(?:'m| am)?\s+(?:just\s+)?(?:want|wanted|would like|'d like|need|trying|looking)(?:\s+to)?\s+(?:to\s+)?(?:learn|know|understand|hear|find out)(?:\s+more)?(?:\s+about)?|(?:please\s+)?tell me(?:\s+more)?\s+about|can you tell me(?:\s+more)?\s+about)\s+/i;

/** Words too common to prove that two clauses are about the same thing. */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "in", "on", "for", "to", "and", "or", "is", "are", "it",
  "that", "this", "how", "what", "why", "your", "my", "me", "i", "about", "more",
  "does", "do", "with", "as", "be", "can", "you",
]);

function contentWords(text: string): string[] {
  return words(text).filter((w) => !STOPWORDS.has(w));
}

/**
 * Drop restating clauses from one sentence, and record every content word the
 * sentence keeps so later sentences are measured against it too.
 */
function dropRedundantRequests(
  sentence: string,
  seen: Set<string>,
): { text: string; dropped: string[] } {
  const parts = sentence.split(/\s*[,;]\s+/);
  const kept: string[] = [];
  const dropped: string[] = [];

  for (const part of parts) {
    if (META_REQUEST.test(part)) {
      const subject = contentWords(part.replace(META_REQUEST, ""));
      // Every subject already named, so this clause adds nothing.
      if (subject.length > 0 && subject.every((w) => seen.has(w))) {
        dropped.push(part);
        continue;
      }
    }
    for (const w of contentWords(part)) seen.add(w);
    kept.push(part);
  }

  // Nothing dropped: hand back the original rather than a rejoined copy, which
  // would quietly turn every semicolon into a comma.
  if (dropped.length === 0) return { text: sentence, dropped };

  // The dropped clause may have carried the full stop away with it, which would
  // run this sentence into the next one.
  const terminator = /[.!?]+$/.exec(sentence)?.[0] ?? "";
  let text = kept.join(", ");
  if (terminator && !/[.!?]$/.test(text)) text += terminator;
  return { text, dropped };
}

/**
 * Definitions the model does not need: ", which is a chemical element",
 * ", which is cold water in a solid state".
 *
 * Only stripped when the prompt carries SEVERAL of them. One "which is ..."
 * usually carries real information the model needs; a prompt with three or
 * more is written in a padding style, and that pattern is what makes removal
 * safe enough to offer. Removal is always shown in the diff and never applied
 * silently, so the person can reject it.
 */
const APPOSITIVE =
  /,\s*(?:which|who)\s+(?:is|was|are|were|means)\b[^,.;?!]{0,120}(?=[,.;?!])/gi;
const APPOSITIVE_MIN = 3;

function stripDefinitions(text: string, whole: string): { text: string; removed: Removal[] } {
  const all = whole.match(APPOSITIVE) ?? [];
  if (all.length < APPOSITIVE_MIN) return { text, removed: [] };
  const removed: Removal[] = [];
  const next = text.replace(APPOSITIVE, (match) => {
    removed.push({
      text: match.trim(),
      why: "Defines a term the model already knows. This prompt has several of these.",
    });
    return "";
  });
  return { text: next, removed };
}

const DUPLICATE_JACCARD = 0.8;
/** Floor for FUZZY matching only: short list items legitimately share wording. */
const DUPLICATE_MIN_WORDS = 6;
/**
 * Floor for EXACT matching. Much lower, because an identical sentence is a
 * repeat at any length and needs no protection from coincidence. Keeping the
 * fuzzy floor here would let "Translate the paragraph into French." repeated
 * verbatim survive, which is the most obvious repeat there is.
 */
const DUPLICATE_EXACT_MIN_WORDS = 3;

/**
 * Known limitation, worth saying out loud on stage.
 *
 * Duplicate detection compares word sets, so it catches a repeat that reuses
 * the wording ("Summarise the article" twice, with or without a "please"). It
 * does NOT catch a paraphrased repeat: "Please summarise this article" and
 * "I would like a summary of the article" share almost no words, so no
 * threshold separates them from two genuinely different instructions.
 *
 * Catching that needs sentence meaning, which would mean a model call, which
 * would mean spending energy and sending the prompt off the device. Both are
 * things this product promises not to do, so the honest answer is that this
 * case is out of scope rather than badly approximated.
 */


// --- pasted context ---------------------------------------------------------

const PASTED_MIN_WORDS = 60;

/**
 * Long blocks that look pasted in. Flagged for the user to confirm, never
 * removed: only they know whether the model needs that context, and silently
 * dropping it is the fastest way to make the rewrite produce a worse answer.
 */
function findPastedContext(prompt: string): RewriteResult["flaggedContext"] {
  const out: RewriteResult["flaggedContext"] = [];
  const paragraphs: { text: string; start: number }[] = [];
  let cursor = 0;
  for (const part of prompt.split(/\n{2,}/)) {
    paragraphs.push({ text: part, start: cursor });
    cursor += part.length + 2;
  }

  for (const p of paragraphs) {
    const w = countWords(p.text);
    if (w < PASTED_MIN_WORDS) continue;

    const quoted = /^\s*>/m.test(p.text);
    const replyHeader = /\bOn .{3,40}\bwrote:/i.test(p.text);
    const secondPerson = /\b(?:you|your|please|I want|I need|give me|write|make|explain)\b/i.test(p.text);

    // Quoted or a reply header is strong evidence. Otherwise: a long block with
    // no second-person address is probably material rather than instruction.
    if (quoted || replyHeader || !secondPerson) {
      out.push({
        start: p.start,
        end: p.start + p.text.length,
        excerpt: p.text.replace(/\s+/g, " ").trim().slice(0, 200),
        words: w,
      });
    }
  }
  return out;
}

// --- rewrite ----------------------------------------------------------------

export interface RewriteOptions {
  checkedAgainstExamples?: boolean;
  /** What this user's replies actually waste tokens on. Shapes the directions. */
  wasteProfile?: WasteProfile;
  /** Add a concrete length to plain requests. On by default; the dashboard can switch it off. */
  withLengthEdit?: boolean;
}

export function rewritePrompt(
  prompt: string,
  taskTypeOverride?: TaskType,
  opts: RewriteOptions = {},
): RewriteResult {
  const taskType = taskTypeOverride ?? detectTaskType(prompt);
  const sentences = splitSentences(prompt);
  const removed: Removal[] = [];
  const diff: DiffOp[] = [];
  const keptNorms: string[] = [];
  const keptTexts: string[] = [];
  /** Content words the prompt has already used, for the clause check below. */
  const seenWords = new Set<string>();

  for (const s of sentences) {
    // 1. Whole-sentence pleasantry.
    if (PLEASANTRY_SENTENCES.some((re) => re.test(s.text.trim()))) {
      removed.push({ text: s.text, why: "Pleasantry with no instruction in it." });
      diff.push({ op: "remove", text: s.text });
      continue;
    }

    // 2. Strip politeness phrases but keep the sentence.
    //
    // This runs before the duplicate check on purpose, so "Please do X" and
    // "Do X" are compared on equal footing. Comparing the raw sentences would
    // let a stray "please" hide a repeat.
    let text = s.text;
    const politenessRemovals: Removal[] = [];
    const definitions = stripDefinitions(text, prompt);
    text = definitions.text;
    politenessRemovals.push(...definitions.removed);
    for (const strip of PHRASE_STRIPS) {
      if (strip.re.test(text)) {
        const before = text;
        text = text.replace(strip.re, " ");
        if (before !== text) politenessRemovals.push({ text: before.trim(), why: strip.why });
      }
    }
    text = tidy(text);

    if (countWords(text) === 0) {
      removed.push({ text: s.text, why: "Nothing left once the politeness was removed." });
      diff.push({ op: "remove", text: s.text });
      continue;
    }

    // 2b. Clauses inside this sentence that restate what has already been asked.
    const pruned = dropRedundantRequests(text, seenWords);
    for (const clause of pruned.dropped) {
      removed.push({ text: clause, why: "Asks again for what you have already asked for." });
    }
    if (pruned.dropped.length > 0) text = tidy(pruned.text);

    if (countWords(text) === 0) {
      removed.push({ text: s.text, why: "The whole sentence repeated an earlier request." });
      diff.push({ op: "remove", text: s.text });
      continue;
    }

    // 3. A repeat of an instruction already given.
    const norm = normalize(text);
    const wordCount = countWords(text);
    const exactRepeat = wordCount >= DUPLICATE_EXACT_MIN_WORDS && keptNorms.includes(norm);
    const fuzzyRepeat =
      wordCount >= DUPLICATE_MIN_WORDS &&
      keptNorms.some((k) => jaccard(k, norm) >= DUPLICATE_JACCARD);
    if (exactRepeat || fuzzyRepeat) {
      removed.push({ text: s.text, why: "Repeats an instruction you already gave." });
      diff.push({ op: "remove", text: s.text });
      continue;
    }

    removed.push(...politenessRemovals);
    if (text !== s.text) {
      diff.push({ op: "remove", text: s.text });
      diff.push({ op: "add", text });
    } else {
      diff.push({ op: "keep", text });
    }
    keptNorms.push(normalize(text));
    keptTexts.push(text);
  }

  const flaggedContext = findPastedContext(prompt);

  // Only add a direction the prompt does not already carry.
  //
  // Without this the rewrite is not idempotent: run it on its own output and it
  // appends the same line again, so a user who clicks "trim" twice watches
  // their prompt grow instead of shrink. It also means a user who already
  // writes "answer directly" themselves is not told to say it twice.
  const haystack = ` ${normalize(keptTexts.join(" "))} `;
  const directions = chooseDirections(
    prompt,
    taskType,
    flaggedContext.length > 0,
    opts.wasteProfile,
  ).filter((line) => line.length > 0 && !haystack.includes(` ${normalize(line)} `));
  const edit = lengthEditFor(prompt, taskType, directions, opts.withLengthEdit !== false);
  const added = [...directions, ...(edit && !haystack.includes(` ${normalize(edit)} `) ? [edit] : [])];
  for (const line of added) diff.push({ op: "add", text: line });

  // Every piece ends in punctuation, so joining them never runs two sentences together.
  const pieces = [...keptTexts, ...added].map((p) => (/[.!?]$/.test(p) ? p : `${p}.`));
  const rewritten = pieces.join(" ").trim();
  const tokenDelta = estimateTokens(rewritten).tokens - estimateTokens(prompt).tokens;

  return {
    original: prompt,
    rewritten,
    taskType,
    diff,
    tokenDelta,
    removed,
    added: [...added],
    flaggedContext,
    checkedAgainstExamples: opts.checkedAgainstExamples ?? false,
  };
}

function tidy(text: string): string {
  // Removing "please" from "DNS, please?" leaves a stray comma before the
  // terminator. Drop commas and spaces that sit directly before a full stop.
  let t = text
    .trim()
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/,\s*([.?!])/g, "$1")
    // Stripping "could you" turns a question into an instruction, and the
    // question mark it left behind no longer matches the sentence.
    .replace(/^((?:explain|describe|list|write|summari[sz]e|give|tell|compare|draft|suggest)\b[^?]*)\?$/i, "$1.")
    .replace(/\s+$/, "")
    .trim();
  if (t.length > 0) t = t[0]!.toUpperCase() + t.slice(1);
  return t;
}

/**
 * Shown with every rewrite. The first line is the one the pitch must not skip:
 * if we imply that trimming the prompt is where the energy goes, a judge who
 * knows how inference is billed will take the whole model apart.
 */
export const REWRITE_CAVEATS: string[] = [
  "Most of the energy saving is in the added output directions, not in the trimmed input. Trimming input mainly saves money and usage-limit headroom.",
  "A short prompt can get slightly longer: a few input tokens buy a length limit that usually removes far more output tokens. The trade is only worth it when the answer would otherwise run long.",
  "Trimming can change meaning. Read the diff before you use it.",
  "Long pasted blocks are flagged, never removed. Only you know if the model needs them.",
];
