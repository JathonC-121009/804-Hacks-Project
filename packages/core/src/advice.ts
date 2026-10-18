import { countWords } from "./text.ts";

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
  if (/\b(?:explain|what is|what's|what are|how does|how do|how can|why|describe|tell me about|walk me through)\b/i.test(prompt)) {
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

/** True when the prompt already sets a length or format. */
export function hasLengthLimit(prompt: string): boolean {
  return LIMIT.test(prompt);
}

function unbounded(prompt: string): PromptAdvice | null {
  if (LIMIT.test(prompt)) return null;
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
  const verbs = (prompt.match(REQUEST_VERB) ?? []).length;
  return questions >= 2 ? questions : verbs >= 2 && CONNECTIVE.test(prompt) ? verbs : 0;
}

function multiAsk(prompt: string): PromptAdvice | null {
  const questions = (prompt.match(/\?/g) ?? []).length;
  const verbs = (prompt.match(REQUEST_VERB) ?? []).length;
  // Two questions, or two requests joined together. A single request that
  // mentions two topics ("explain DNS and DHCP") is not counted.
  const asks = questions >= 2 ? questions : verbs >= 2 && CONNECTIVE.test(prompt) ? verbs : 0;
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

/** Every piece of advice that applies to this prompt, most useful first. */
export function adviseOnPrompt(prompt: string): PromptAdvice[] {
  if (prompt.trim().length === 0) return [];
  const checks = [largePaste, missingError, multiAsk, unbounded, vagueGoal];
  return checks.map((check) => check(prompt)).filter((advice): advice is PromptAdvice => advice !== null);
}
