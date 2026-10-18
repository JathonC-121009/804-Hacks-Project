import type { Flag, FlagType, InstructionBlock } from "./types.ts";
import { countWords } from "./text.ts";

/**
 * The standing instruction block (plan section 5.3).
 *
 * One short block the user pastes once into their AI's standing-instructions
 * setting, so it applies to every future chat instead of one response. This is
 * the fix with the widest reach, which is why it leads the demo.
 *
 * It must stay short: the block is sent as input on every single message, so a
 * long one spends tokens forever to save tokens once. Hard cap of 60 words,
 * checked by the D2 acceptance test.
 */

const MAX_WORDS = 60;

/** Each waste type maps to exactly one line. Order here is the tie-break order. */
const LINES: { type: FlagType; line: string }[] = [
  { type: "echo", line: "Answer directly. Do not restate my question." },
  { type: "filler", line: "No greetings, no praise for the question, no closing offers of more help." },
  { type: "repetition", line: "Do not repeat a point you have already made." },
  { type: "recap", line: "No summary or recap at the end unless I ask for one." },
  { type: "boilerplate", line: "Skip standard disclaimers unless they matter for this answer." },
  { type: "overlength", line: "Keep the answer as short as the question allows." },
];

/**
 * Build the block from the waste actually seen, heaviest first.
 *
 * @param flags   flags from the response being looked at
 * @param history flags from this user's earlier responses, so the block reflects
 *                their habits rather than one unlucky answer
 */
export function buildInstructionBlock(flags: Flag[], history: Flag[] = []): InstructionBlock {
  const weight = new Map<FlagType, number>();
  for (const f of [...flags, ...history]) {
    // Advisory flags still shape advice even though they never move the score:
    // a recap is worth telling the AI to stop doing, it is just not countable.
    const add = f.tokens > 0 ? f.tokens : 1;
    weight.set(f.type, (weight.get(f.type) ?? 0) + add);
  }

  const ranked = LINES.filter((l) => weight.has(l.type)).sort((a, b) => {
    const diff = (weight.get(b.type) ?? 0) - (weight.get(a.type) ?? 0);
    if (diff !== 0) return diff;
    return LINES.findIndex((l) => l.type === a.type) - LINES.findIndex((l) => l.type === b.type);
  });

  const lines: string[] = [];
  const basedOn: { type: FlagType; tokens: number }[] = [];
  let words = 0;
  for (const entry of ranked) {
    const lineWords = countWords(entry.line);
    if (words + lineWords > MAX_WORDS) continue;
    lines.push(entry.line);
    basedOn.push({ type: entry.type, tokens: weight.get(entry.type) ?? 0 });
    words += lineWords;
  }

  return {
    lines,
    block: lines.join(" "),
    wordCount: words,
    basedOn,
  };
}

/**
 * Said next to the block in the UI. Brevity instructions are not free: the ACL
 * 2025 result is about preserving quality on the tasks it tested, not a promise
 * for every task, so the honest framing is "simple, repeated work".
 */
export const INSTRUCTION_CAVEATS: string[] = [
  "This block is sent with every message, so keeping it short matters.",
  "Brevity instructions can hurt quality on complex work. Best on simple, repeated tasks.",
  "Where to paste it differs by product, and the setting names change. Check your AI's current settings.",
];
