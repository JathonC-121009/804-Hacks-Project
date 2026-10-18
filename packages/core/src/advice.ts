import { countWords } from "./text.ts";
import { lengthTargetWords } from "./detect.ts";

/**
 * Prompt advice: checks that look at what the request asks for, not at how the
 * wording is phrased.
 *
 * Every check is a rule a person can read, and every suggestion quotes the part
 * of the prompt it is about. A rule that fires on a prompt that is fine is worse
 * than no rule, so each one has a negative test in advice.test.ts.
 *
 * What these cannot do: judge whether an answer is correct, or whether the
 * question is a good one. They find requests that are likely to make the model
 * write more than it needs to, and they say so.
 */

export type AdviceKind = "unbounded" | "multi_ask" | "large_paste" | "vague_goal" | "missing_error";

export interface PromptAdvice {
  kind: AdviceKind;
  /** The part of the prompt the advice is about. */
  quote: string;
  why: string;
  /** A concrete change the person can make. */
  suggestion: string;
  confidence: "high" | "medium";
}

/** Limits a prompt can already carry. Any one of them means the length is set. */
const LIMIT = new RegExp(
  [
    String.raw`\b(?:in|under|within|at most|no more than|max(?:imum)?|around|about)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|a few)\s+(?:words?|sentences?|lines?|bullets?|points?|paragraphs?|items?|steps?)\b`,
    String.raw`\b(?:briefly|brief|concise(?:ly)?|short answer|one sentence|one line|one word|tl;?dr)\b`,
    String.raw`\b(?:bullets?|bullet points?|a table|as a table|in json|as json|yes or no|just the|only the)\b`,
  ].join("|"),
  "i",
);

export type RequestKind = "explain" | "write" | "list" | "summarize" | "other";

export function requestKind(prompt: string): RequestKind {
  if (/\b(?:summari[sz]e|summary|tl;?dr)\b/i.test(prompt)) return "summarize";
  if (/\b(?:list|give me (?:some|a few|\d+)|name (?:some|a few|\d+)|brainstorm|ideas for)\b/i.test(prompt)) return "list";
  if (/\b(?:write|draft|compose|create (?:a|an|the)|rewrite)\b/i.test(prompt)) return "write";
  // A request is often phrased as a wish: "I want to learn about X" asks for
  // the same thing as "Explain X", and the tool was treating it as no request
  // at all, so it offered nothing.
  if (
    /\b(?:explain|what is|what's|what are|how does|how do|how can|how it works?|why|describe|tell me about|teach me|walk me through|help me understand|want to (?:learn|know|understand)|interested in)\b/i.test(
      prompt,
    )
  ) {
    return "explain";
  }
  return "other";
}

const SUGGESTION_FOR: Record<RequestKind, string> = {
  explain: 'Add a length, for example "in 3 sentences for a beginner". Open-ended explanations run long, and every extra sentence is output you pay for.',
  write: 'Add a limit, for example "under 150 words".',
  list: 'Add a count, for example "5 bullets, one line each".',
  summarize: 'Add a size, for example "in 3 bullets".',
  other: 'Add a length or format, for example "in 3 sentences" or "as a table".',
};

/**
 * True when the prompt already sets a length or format.
 *
 * Also asks the scorer's parser: it understands counts this regex does not
 * ("in exactly 3 sentences"). The two must agree, because when they disagree
 * the rewrite adds a SECOND limit that contradicts the one the user wrote,
 * which changes what they asked for.
 */
export function hasLengthLimit(prompt: string): boolean {
  return LIMIT.test(prompt) || lengthTargetWords(prompt) !== null;
}

function unbounded(prompt: string): PromptAdvice | null {
  // hasLengthLimit, not LIMIT: the regex alone misses "in exactly 3
  // sentences", so this told people to add a length they had already written.
  if (hasLengthLimit(prompt)) return null;
  const kind = requestKind(prompt);
  // A bare statement with no request in it is not something to bound.
  if (kind === "other" && !/\?\s*$/.test(prompt.trim())) return null;
  return {
    kind: "unbounded",
    quote: prompt.trim().slice(0, 120),
    why: "No length or format is set, so the model decides how long to write.",
    suggestion: SUGGESTION_FOR[kind],
    confidence: kind === "other" ? "medium" : "high",
  };
}

const REQUEST_VERB = /\b(?:explain|tell|list|give|show|compare|write|describe|summari[sz]e|name|draft|suggest)\b/gi;
const CONNECTIVE = /\b(?:and|also|plus|then)\b/i;

export function isMultiAsk(prompt: string): boolean {
  return multiAskCount(prompt) >= 2;
}

function multiAskCount(prompt: string): number {
  const questions = (prompt.match(/\?/g) ?? []).length;
  if (questions >= 2) return questions;
  // "show, depict, and illustrate" is one request said three ways. Counting
  // each verb turns a single ask into a false "you asked for four things".
  const verbList = REQUEST_VERB.source.slice(2, -2);
  const single = prompt.replace(new RegExp(`,\\s*(?:and\\s+)?(?:${verbList})\\b`, "gi"), "");
  const verbs = (single.match(REQUEST_VERB) ?? []).length;
  // The connective has to actually join two asks. "A guide that will show the
  // process" has a second verb inside a relative clause, not a second request.
  const joined = new RegExp(`\\b(?:and|also|then|plus)\\s+(?:\\w+\\s+){0,1}(?:${verbList})\\b`, "i").test(single);
  return verbs >= 2 && joined ? verbs : 0;
}

function multiAsk(prompt: string): PromptAdvice | null {
  const asks = multiAskCount(prompt);
  if (asks < 2) return null;
  return {
    kind: "multi_ask",
    quote: prompt.trim().slice(0, 120),
    why: `This asks for ${asks} things in one message. One reply has to cover all of them, and it usually runs long.`,
    suggestion: "Send them as separate messages, or number them and ask for one line each.",
    confidence: "medium",
  };
}

/** A pasted block of text or code, measured the way the rewrite measures it. */
const PASTED_MIN_WORDS = 60;

/**
 * A long block the person pasted in, as distinct from a long instruction.
 *
 * Requiring a separate block matters: a single flowing paragraph is someone
 * writing a detailed request, not pasting context, and telling them to trim it
 * to "the lines around the problem" is advice about a problem they do not have.
 */
function largePaste(prompt: string): PromptAdvice | null {
  const fenced = prompt.match(/```[\s\S]*?```/g)?.join("\n") ?? "";
  if (fenced) {
    const words = countWords(fenced);
    if (words >= PASTED_MIN_WORDS) return pasteAdvice(words, "code block");
    return null;
  }
  // No fence: only count a block that is set apart from the rest of the prompt.
  const blocks = prompt.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length < 2) return null;
  const biggest = blocks.slice().sort((a, b) => countWords(b) - countWords(a))[0] ?? "";
  const words = countWords(biggest);
  if (words < PASTED_MIN_WORDS) return null;
  // The block has to dominate: otherwise this is just a multi-paragraph request.
  if (words / Math.max(1, countWords(prompt)) < 0.6) return null;
  return pasteAdvice(words, "block of text");
}

function pasteAdvice(words: number, kind: string): PromptAdvice {
  return {
    kind: "large_paste",
    quote: `${words}-word ${kind}`,
    why: "The model reads all of this before answering, and you pay for every word of it.",
    suggestion: "Include only the part the question is about, and say which part matters.",
    confidence: "medium",
  };
}

const VAGUE = /\b(?:make (?:it|this|that) (?:better|nicer|cleaner|good)|improve (?:it|this|that)|fix (?:it|this|that)|better|nicer|cleaner)\b/i;
const HAS_CRITERIA = /\b(?:so that|must|should|faster|shorter|smaller|under|without|keep|avoid|only|like|example)\b|\d|["'`]/i;

function vagueGoal(prompt: string): PromptAdvice | null {
  if (countWords(prompt) > 12) return null;
  if (!VAGUE.test(prompt) || HAS_CRITERIA.test(prompt)) return null;
  return {
    kind: "vague_goal",
    quote: prompt.trim(),
    why: "'Better' has no definition here, so the model has to guess what you want and may write a long rewrite to cover every reading.",
    suggestion: 'Say what better means, for example "shorter, same meaning, keep the headings".',
    confidence: "medium",
  };
}

const ERROR_WORDS = /\b(?:error|exception|traceback|doesn'?t work|does not work|not working|fails?|crash(?:es|ed)?|undefined is not|cannot read)\b/i;

function missingError(prompt: string): PromptAdvice | null {
  if (!ERROR_WORDS.test(prompt)) return null;
  // The error text itself is the clue: a quoted message, a stack frame or a code block.
  if (/```|Error:|at \w+.*\(|\bline \d+\b|"[^"]{12,}"/i.test(prompt)) return null;
  return {
    kind: "missing_error",
    quote: prompt.trim().slice(0, 120),
    why: "You describe a failure without the message itself. The model then guesses the cause, and guesses are often long.",
    suggestion: "Paste the exact error message and the one line it points to. That usually gets a shorter, more exact answer.",
    confidence: "medium",
  };
}

/**
 * What a length limit would have saved on a reply that already arrived.
 *
 * This is NOT scored as waste. Nobody asked for a shorter answer, so calling
 * the extra words waste would be inventing a requirement. It is reported
 * instead, because "you did not set a limit" is useless on its own and "a
 * 3-sentence limit would have saved about 60 words" is something to act on.
 *
 * Returns null when the prompt already sets a length (then it IS scored), or
 * when the request kind has no sensible default.
 */
const BASELINE_WORDS: Partial<Record<RequestKind, { words: number; ask: string }>> = {
  explain: { words: 60, ask: "in 3 sentences" },
  write: { words: 150, ask: "under 150 words" },
  list: { words: 75, ask: "5 bullets" },
  summarize: { words: 45, ask: "in 3 bullets" },
};

export interface LengthOpportunity {
  replyWords: number;
  targetWords: number;
  excessWords: number;
  ask: string;
}

export function lengthOpportunity(prompt: string, response: string): LengthOpportunity | null {
  if (hasLengthLimit(prompt)) return null;
  const baseline = BASELINE_WORDS[requestKind(prompt)];
  if (!baseline) return null;
  const replyWords = countWords(response);
  const excess = replyWords - baseline.words;
  // A reply already inside the baseline had nothing to gain from a limit.
  if (excess < 20) return null;
  return { replyWords, targetWords: baseline.words, excessWords: excess, ask: baseline.ask };
}

/** Every piece of advice that applies to this prompt, most useful first. */
export function adviseOnPrompt(prompt: string): PromptAdvice[] {
  if (prompt.trim().length === 0) return [];
  const checks = [largePaste, missingError, multiAsk, unbounded, vagueGoal];
  return checks.map((check) => check(prompt)).filter((advice): advice is PromptAdvice => advice !== null);
}
