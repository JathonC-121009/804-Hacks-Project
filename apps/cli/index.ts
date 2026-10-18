#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  FirestoreClient,
  isFirebaseConfigured,
  pushUsageEvent,
  refreshLeaderboardRow,
  refreshSession,
  rewritePrompt,
  runFullAnalysis,
  signInWithPassword,
  suggestModel,
  estimateTokens,
  syncUsageEvent,
  type AuthSession,
  type Config,
  type FirebaseWebConfig,
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
  commandArgs: string[];
}

const HELP = `PromptFootprint CLI

Optimize prompts before they reach any terminal AI, then analyze the output.
All PromptFootprint analysis stays local.

Usage:
  npm run cli -- run --prompt "..." -- gemini -p
  npm run cli -- run --prompt "..." -- claude -p
  npm run cli -- run --prompt "..." -- codex exec
  npm run cli -- run --prompt "..." -- ollama run MODEL
  npm run cli -- analyze --prompt "..." --response "..."
  npm run cli -- rewrite --prompt "..."
  npm run cli -- suggest --prompt "..."
  npm run cli -- login --email you@example.com

Run behavior:
  1. Removes local prompt waste and adds a concise output instruction.
  2. Shows the recommended model tier.
  3. Sends the fixed prompt to the command after -- and analyzes its answer.

Run options:
  -p, --prompt TEXT              Original prompt
      --prompt-file PATH         Read the prompt from a UTF-8 file
      --tool NAME                Provider/tool label (defaults to executable name)
  -m, --model-class TIER         Actual model tier: small, medium, or large
      --current-tier TIER        Current tier used for the recommendation
      --dry-run                  Show the fixed prompt without running the AI
      --no-color                 Disable ANSI color

Account sync (optional, Firebase free plan):
  login --email ADDRESS          Sign in once; later analyses sync automatically
  logout                         Forget the saved session on this machine
      --password TEXT            Non-interactive password (prefer the prompt)
  PROMPTFOOTPRINT_PASSWORD       Password for scripted logins

The session is stored in ~/.promptfootprint/config.json with 0600 permissions.
Only measurements are uploaded: token counts, an efficiency score, which
detectors fired and resource ranges. Prompt and response text never leave.

The fixed prompt is appended to the command. Put a quoted "{prompt}" argument
after -- to place it somewhere else instead.

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
  npm run cli -- run -p "Please explain DNS please" -- gemini -p
  npm run cli -- run -p "Summarize notes.txt" -- my-ai --message "{prompt}"
  gemini -p "Explain DNS" | npm run cli -- analyze -p "Explain DNS" --tool gemini
  npm run cli -- analyze -p "Summarize this" -r "Great question..." --json
  npm run cli -- login --email you@example.com
`;

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const first = args[0];
  const command = first && !first.startsWith("-") ? args.shift()! : "analyze";
  const options: Options = {};
  const positional: string[] = [];
  const commandArgs: string[] = [];
  const aliases: Record<string, string> = {
    p: "prompt",
    r: "response",
    m: "model-class",
    h: "help",
  };

  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--") {
      commandArgs.push(...args);
      break;
    }
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const raw = arg.replace(/^--?/, "");
    const [nameWithAlias = "", inline] = raw.split(/=(.*)/s, 2);
    const name = aliases[nameWithAlias] ?? nameWithAlias;
    if (["json", "help", "no-color", "dry-run"].includes(name)) {
      options[name] = true;
      continue;
    }
    const value = inline ?? args.shift();
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    options[name] = value;
  }
  return { command, positional, options, commandArgs };
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
  const adviceLines = result.promptAdvice.map((a) => `  • ${a.why} ${a.suggestion}`);
  if (flags.length === 0) lines.push("  No high-confidence waste detected.");
  for (const flag of flags) {
    lines.push(`  • ${flag.type}: ${flag.why}${flag.excerpt ? ` ${dim(`“${flag.excerpt}”`)}` : ""}`);
  }

  lines.push(
    "",
    ...(adviceLines.length ? [bold("Your prompt"), ...adviceLines, ""] : []),
    bold("Three fixes"),
    `  1. Standing instruction: ${result.instructionBlock.block || "No recurring waste pattern yet."}`,
    `  2. Shorter prompt: ${result.rewrite.rewritten}`,
    `     ${dim(`${originalPromptTokens} → ${rewrittenPromptTokens} estimated input tokens (${result.rewrite.tokenDelta >= 0 ? "+" : ""}${result.rewrite.tokenDelta})`)}`,
    `  3. Model suggestion: ${result.suggestion.label} (${result.suggestion.confidence} confidence)`,
    ...result.suggestion.recommendations.map(
      (r) => `     ${r.platform}: ${r.model} at ${r.effort} effort${r.verified ? "" : dim(" (unchecked name)")}`,
    ),
    "",
    dim(analysis.coverage.note),
    dim(`Grid: ${result.grid.source}. Estimates are ranges, not measurements.`),
  );

  if (estimate.provenance.assumptions.length > 0) {
    lines.push(dim(`Assumptions: ${estimate.provenance.assumptions.join(" ")}`));
  }
  return lines.join("\n");
}

function useColor(options: Options, stream: NodeJS.WriteStream): boolean {
  return stream.isTTY && !options["no-color"] && !process.env.NO_COLOR;
}

function preflightReport(
  original: string,
  fixed: string,
  suggestion: ReturnType<typeof suggestModel>,
  color: boolean,
): string {
  const bold = (s: string) => (color ? `\u001b[1m${s}\u001b[0m` : s);
  const dim = (s: string) => (color ? `\u001b[2m${s}\u001b[0m` : s);
  const before = estimateTokens(original).tokens;
  const after = estimateTokens(fixed).tokens;
  return [
    bold("PromptFootprint preflight"),
    `  Auto-fix applied: ${before} → ${after} estimated input tokens`,
    `  Suggested model: ${suggestion.label} (${suggestion.confidence} confidence)`,
    ...suggestion.recommendations.map((r) => `    ${r.platform}: ${r.model} at ${r.effort} effort`),
    `  ${dim("Sending:")} ${fixed}`,
  ].join("\n");
}

function commandWithPrompt(commandArgs: string[], prompt: string): { executable: string; args: string[] } {
  if (commandArgs.length === 0) {
    throw new Error('A terminal AI command is required after --. Example: run -p "Explain DNS" -- gemini -p');
  }
  const [executable, ...rawArgs] = commandArgs;
  if (!executable) throw new Error("The command after -- is empty.");
  let replaced = false;
  const args = rawArgs.map((arg) => {
    if (!arg.includes("{prompt}")) return arg;
    replaced = true;
    return arg.replaceAll("{prompt}", prompt);
  });
  if (!replaced) args.push(prompt);
  return { executable, args };
}

async function execute(command: { executable: string; args: string[] }): Promise<{ output: string; status: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      stdio: ["inherit", "pipe", "inherit"],
      shell: false,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      process.stdout.write(chunk);
    });
    child.on("error", (error) => reject(new Error(`Could not start ${command.executable}: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (signal) reject(new Error(`${command.executable} ended from signal ${signal}.`));
      else resolve({ output: Buffer.concat(chunks).toString("utf8"), status: code ?? 1 });
    });
  });
}

async function runCommand(parsed: ParsedArgs): Promise<number> {
  const config = await loadConfig();
  const original = (await readTextOption(parsed.options, "prompt")) || parsed.positional.join(" ");
  if (!original.trim()) throw new Error("A prompt is required. Use --prompt or --prompt-file.");

  const rewrite = rewritePrompt(original);
  const currentTier = tier(parsed.options["current-tier"], config.models.default_assumed_tier);
  const suggestion = suggestModel(original, config, currentTier);
  const color = useColor(parsed.options, process.stderr);
  console.error(preflightReport(original, rewrite.rewritten, suggestion, color));
  if (parsed.options["dry-run"]) return 0;

  const command = commandWithPrompt(parsed.commandArgs, rewrite.rewritten);
  const run = await execute(command);
  if (run.status !== 0) {
    console.error(`\nPromptFootprint: ${command.executable} exited with status ${run.status}; output was not scored.`);
    return run.status;
  }
  if (!run.output.trim()) {
    console.error(`\nPromptFootprint: ${command.executable} returned no text to analyze.`);
    return 0;
  }

  const modelClass = tier(parsed.options["model-class"], currentTier);
  const result = runFullAnalysis(
    {
      prompt: rewrite.rewritten,
      response: run.output,
      modelClass,
      grid: await loadGrid(),
      pricePerOutputToken: numberOption(parsed.options, "price"),
      assumedCurrentTier: currentTier,
      surface: "cli",
      tool: typeof parsed.options.tool === "string" ? parsed.options.tool : command.executable,
    },
    config,
  );
  console.error(`\n${humanReport(result, color)}`);
  await syncResult(result);
  return 0;
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
  else console.log(humanReport(result, useColor(parsed.options, process.stdout)));
  await syncResult(result);
}

/** The saved session. Holds a refresh token, never a password. */
interface StoredSession extends AuthSession {
  email: string;
}

function syncConfigPath(): string {
  return join(homedir(), ".promptfootprint", "config.json");
}

async function readStoredSession(): Promise<StoredSession | null> {
  try {
    const value = JSON.parse(await readFile(syncConfigPath(), "utf8")) as Partial<StoredSession>;
    return value.uid && value.refreshToken && value.idToken
      ? {
          uid: value.uid,
          email: value.email ?? "",
          idToken: value.idToken,
          refreshToken: value.refreshToken,
          expiresAt: value.expiresAt ?? 0,
        }
      : null;
  } catch {
    return null;
  }
}

async function writeStoredSession(session: StoredSession): Promise<void> {
  const path = syncConfigPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

async function loadFirebaseConfig(): Promise<FirebaseWebConfig> {
  const config = (await readJson(new URL("../../config/firebase.json", import.meta.url)).catch(
    () => null,
  )) as FirebaseWebConfig | null;
  if (!isFirebaseConfigured(config)) {
    throw new Error(
      "Firebase is not configured. Copy config/firebase.example.json to config/firebase.json and paste your web app values.",
    );
  }
  return config as FirebaseWebConfig;
}

/**
 * Read a password without echoing it.
 *
 * A password passed as --password lands in the shell history and in `ps`, so
 * the flag exists for scripts and this prompt is the path a person should use.
 */
async function askPassword(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("No terminal to ask for a password. Use --password or PROMPTFOOTPRINT_PASSWORD.");
  }
  process.stderr.write(promptText);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  try {
    for await (const chunk of process.stdin) {
      const text = Buffer.from(chunk).toString("utf8");
      if (text.includes("\u0003")) throw new Error("Cancelled.");
      if (text.includes("\r") || text.includes("\n")) break;
      if (text === "\u007f" || text === "\b") value = value.slice(0, -1);
      else value += text.replace(/[\u0000-\u001f]/g, "");
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write("\n");
  }
  return value;
}

async function loginCommand(parsed: ParsedArgs): Promise<void> {
  const config = await loadFirebaseConfig();
  const email = typeof parsed.options.email === "string" ? parsed.options.email.trim() : "";
  if (!email.includes("@")) throw new Error("--email is required. Use the account from the dashboard.");
  const password =
    (typeof parsed.options.password === "string" ? parsed.options.password : "") ||
    process.env.PROMPTFOOTPRINT_PASSWORD ||
    (await askPassword(`Password for ${email}: `));
  if (!password) throw new Error("A password is required.");
  const session = await signInWithPassword(config.apiKey, email, password);
  await writeStoredSession({ ...session, email });
  console.log(
    `Signed in as ${email}. Future analyses sync to your dashboard and leaderboard row.\nSaved: ${syncConfigPath()}`,
  );
}

async function logoutCommand(): Promise<void> {
  const path = syncConfigPath();
  await writeFile(path, "{}\n", { mode: 0o600 }).catch(() => undefined);
  console.log(`Signed out. Measurements stay on this machine.\nCleared: ${path}`);
}

/**
 * A client for the saved session, refreshing the token when it has aged out.
 *
 * Returns null rather than throwing when nothing is signed in: sync is opt-in,
 * and a local analysis must not fail because an account was never connected.
 */
async function syncClient(): Promise<FirestoreClient | null> {
  const stored = await readStoredSession();
  if (!stored) return null;
  const config = await loadFirebaseConfig();
  let session: AuthSession = stored;
  if (session.expiresAt - Date.now() < 60_000) {
    session = await refreshSession(config.apiKey, session.refreshToken);
    await writeStoredSession({ ...session, email: stored.email });
  }
  return new FirestoreClient(config, session, {
    onSession: (next) => writeStoredSession({ ...next, email: stored.email }),
  });
}

async function syncResult(result: FullAnalysis): Promise<void> {
  const record = syncUsageEvent({
    id: result.event.id,
    timestamp: result.event.timestamp,
    surface: "cli",
    tool: result.event.tool,
    modelClass: result.event.model_class,
    tokens: result.event.tokens,
    totalOutputTokens: result.analysis.totalOutputTokens,
    wastedOutputTokens: result.analysis.wastedOutputTokens,
    efficiency: result.analysis.efficiency,
    flags: result.analysis.flags,
    estimate: result.estimate,
  });
  try {
    const client = await syncClient();
    if (!client) return;
    await pushUsageEvent(client, record);
    await refreshLeaderboardRow(client);
    console.error("PromptFootprint: synced to your account and leaderboard.");
  } catch (error) {
    console.error(`PromptFootprint: analysis completed, but account sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    if (parsed.command === "run") return await runCommand(parsed);
    if (parsed.command === "login") await loginCommand(parsed);
    else if (parsed.command === "logout") await logoutCommand();
    else if (parsed.command === "analyze") await analyzeCommand(parsed);
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

