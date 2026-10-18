#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  rewritePrompt,
  runFullAnalysis,
  suggestModel,
  estimateTokens,
  type Config,
  type FullAnalysis,
  type GridData,
  type ModelClass,
  type Range,
  type TokenCounts,
} from "../../packages/core/src/index.ts";

type Options = Record<string, string | boolean>;

interface ParsedArgs {
  command: string;
  positional: string[];
  options: Options;
}

const HELP = `PromptFootprint CLI

Analyze AI output from any terminal tool. All text analysis stays local.

Usage:
  npm run cli -- analyze --prompt "..." --response "..."
  ai-command | npm run cli -- analyze --prompt "..."
  npm run cli -- analyze --prompt-file prompt.txt --response-file answer.txt
  npm run cli -- rewrite --prompt "..."
  npm run cli -- suggest --prompt "..."

Analyze options:
  -p, --prompt TEXT              Prompt text
  -r, --response TEXT            Response text (stdin is used when omitted)
      --prompt-file PATH         Read the prompt from a UTF-8 file
      --response-file PATH       Read the response from a UTF-8 file
  -m, --model-class TIER         small, medium, or large (default: large)
      --current-tier TIER        Tier assumed for model suggestions
      --tool NAME                Provider/tool label (default: terminal)
      --input-tokens N           Exact input tokens
      --output-tokens N          Exact visible output tokens
      --reasoning-tokens N       Exact hidden reasoning tokens
      --cache-read N             Exact cache-read tokens
      --cache-write N            Exact cache-write tokens
      --price N                  USD per output token
      --json                     Machine-readable JSON output
      --no-color                 Disable ANSI color
  -h, --help                     Show this help

Examples:
  gemini -p "Explain DNS" | npm run cli -- analyze -p "Explain DNS" --tool gemini
  npm run cli -- analyze -p "Summarize this" -r "Great question..." --json
`;

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const first = args[0];
  const command = first && !first.startsWith("-") ? args.shift()! : "analyze";
  const options: Options = {};
  const positional: string[] = [];
  const aliases: Record<string, string> = {
    p: "prompt",
    r: "response",
    m: "model-class",
    h: "help",
  };

  while (args.length > 0) {
    const arg = args.shift()!;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const raw = arg.replace(/^--?/, "");
    const [nameWithAlias = "", inline] = raw.split(/=(.*)/s, 2);
    const name = aliases[nameWithAlias] ?? nameWithAlias;
    if (["json", "help", "no-color"].includes(name)) {
      options[name] = true;
      continue;
    }
    const value = inline ?? args.shift();
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    options[name] = value;
  }
  return { command, positional, options };
}

async function loadConfig(): Promise<Config> {
  const [sources, models] = await Promise.all([
    readJson(new URL("../../config/sources.json", import.meta.url)),
    readJson(new URL("../../config/models.json", import.meta.url)),
  ]);
  return { sources, models } as Config;
}

async function loadGrid(): Promise<GridData | null> {
  try {
    return (await readJson(new URL("../../data/grid_pjm.json", import.meta.url))) as GridData;
  } catch {
    return null;
  }
}

async function readJson(path: URL): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readTextOption(options: Options, name: "prompt" | "response"): Promise<string> {
  const direct = options[name];
  if (typeof direct === "string") return direct;
  const file = options[`${name}-file`];
  if (typeof file === "string") return readFile(file, "utf8");
  return "";
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function tier(value: string | boolean | undefined, fallback: ModelClass): ModelClass {
  if (value === undefined) return fallback;
  if (value === "small" || value === "medium" || value === "large") return value;
  throw new Error(`Invalid model tier "${String(value)}". Use small, medium, or large.`);
}

function numberOption(options: Options, name: string): number | undefined {
  const raw = options[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number.`);
  return value;
}

function exactTokens(options: Options): TokenCounts | undefined {
  const names = ["input-tokens", "output-tokens", "reasoning-tokens", "cache-read", "cache-write"];
  if (!names.some((name) => options[name] !== undefined)) return undefined;
  const output = numberOption(options, "output-tokens");
  if (output === undefined) throw new Error("--output-tokens is required when supplying exact token counts.");
  return {
    input: numberOption(options, "input-tokens") ?? 0,
    output,
    reasoning: numberOption(options, "reasoning-tokens") ?? 0,
    cache_read: numberOption(options, "cache-read") ?? 0,
    cache_write: numberOption(options, "cache-write") ?? 0,
  };
}

function formatRange(range: Range): string {
  const digits = range.high < 0.01 ? 6 : range.high < 10 ? 3 : 1;
  return `${range.low.toFixed(digits)}–${range.high.toFixed(digits)} ${range.unit}`;
}

function humanReport(result: FullAnalysis, color: boolean): string {
  const bold = (s: string) => (color ? `\u001b[1m${s}\u001b[0m` : s);
  const dim = (s: string) => (color ? `\u001b[2m${s}\u001b[0m` : s);
  const { analysis, estimate } = result;
  const originalPromptTokens = estimateTokens(result.rewrite.original).tokens;
  const rewrittenPromptTokens = estimateTokens(result.rewrite.rewritten).tokens;
  const lines = [
    `${bold("Efficiency")}  ${Math.round(analysis.efficiency * 100)}%  ${dim(`(${analysis.wastedOutputTokens}/${analysis.totalOutputTokens} output tokens flagged)`)}`,
    "",
    bold("Estimated wasted resources"),
    `  Energy  ${formatRange(estimate.wasted.energyWh)}`,
    `  Water   ${formatRange(estimate.wasted.waterMl)}`,
    `  CO₂     ${formatRange(estimate.wasted.co2g)}`,
    `  Cost    ${formatRange(estimate.wasted.cost)}`,
    "",
    bold("Waste detected"),
  ];

  const flags = [...analysis.flags, ...analysis.promptFlags];
  if (flags.length === 0) lines.push("  No high-confidence waste detected.");
  for (const flag of flags) {
    lines.push(`  • ${flag.type}: ${flag.why}${flag.excerpt ? ` ${dim(`“${flag.excerpt}”`)}` : ""}`);
  }

  lines.push(
    "",
    bold("Three fixes"),
    `  1. Standing instruction: ${result.instructionBlock.block || "No recurring waste pattern yet."}`,
    `  2. Shorter prompt: ${result.rewrite.rewritten}`,
    `     ${dim(`${originalPromptTokens} → ${rewrittenPromptTokens} estimated input tokens (${result.rewrite.tokenDelta >= 0 ? "+" : ""}${result.rewrite.tokenDelta})`)}`,
    `  3. Model suggestion: ${result.suggestion.label} (${result.suggestion.confidence} confidence)`,
    "",
    dim(`Grid: ${result.grid.source}. Estimates are ranges, not measurements.`),
  );

  if (estimate.provenance.assumptions.length > 0) {
    lines.push(dim(`Assumptions: ${estimate.provenance.assumptions.join(" ")}`));
  }
  return lines.join("\n");
}

async function analyzeCommand(parsed: ParsedArgs): Promise<void> {
  const config = await loadConfig();
  const prompt = await readTextOption(parsed.options, "prompt");
  let response = await readTextOption(parsed.options, "response");
  if (!response) response = await readStdin();
  if (!prompt.trim()) throw new Error("A prompt is required. Use --prompt or --prompt-file.");
  if (!response.trim()) throw new Error("A response is required. Use --response, --response-file, or pipe it on stdin.");

  const modelClass = tier(parsed.options["model-class"], config.models.default_assumed_tier);
  const tokens = exactTokens(parsed.options);
  const result = runFullAnalysis(
    {
      prompt,
      response,
      modelClass,
      ...(tokens ? { tokens, tokenSource: "exact" as const } : {}),
      grid: await loadGrid(),
      pricePerOutputToken: numberOption(parsed.options, "price"),
      assumedCurrentTier: tier(parsed.options["current-tier"], modelClass),
      surface: "cli",
      tool: typeof parsed.options.tool === "string" ? parsed.options.tool : "terminal",
    },
    config,
  );

  if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(humanReport(result, process.stdout.isTTY && !parsed.options["no-color"] && !process.env.NO_COLOR));
}

async function promptOnlyCommand(parsed: ParsedArgs): Promise<void> {
  const config = await loadConfig();
  const prompt = (await readTextOption(parsed.options, "prompt")) || (await readStdin());
  if (!prompt.trim()) throw new Error("A prompt is required. Use --prompt, --prompt-file, or stdin.");
  if (parsed.command === "rewrite") {
    const value = rewritePrompt(prompt);
    console.log(parsed.options.json ? JSON.stringify(value, null, 2) : value.rewritten);
    return;
  }
  const value = suggestModel(
    prompt,
    config,
    tier(parsed.options["current-tier"], config.models.default_assumed_tier),
  );
  console.log(parsed.options.json ? JSON.stringify(value, null, 2) : value.label);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.options.help || parsed.command === "help") {
      console.log(HELP);
      return 0;
    }
    if (parsed.command === "analyze") await analyzeCommand(parsed);
    else if (parsed.command === "rewrite" || parsed.command === "suggest") await promptOnlyCommand(parsed);
    else throw new Error(`Unknown command "${parsed.command}".\n\n${HELP}`);
    return 0;
  } catch (error) {
    console.error(`PromptFootprint: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}

