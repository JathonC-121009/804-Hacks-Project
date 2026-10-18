/**
 * Generates the demo data in data/ (plan section 9.3).
 *
 * Run: npm run seed
 *
 * Two rules this script follows, because the demo is shown to judges:
 *
 * 1. Event flags are produced by running the real detectors over real
 *    prompt/response text, never written by hand. Hand-written flag counts
 *    would let the demo show numbers the engine cannot actually produce.
 *
 * 2. Everything it writes is marked as demo or seeded data, and the grid rows
 *    use source "seeded" so they can never be mistaken for a live EIA call.
 *
 * It anchors on today's date, so re-run it on the morning of the event and the
 * card and chart will look current.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { analyze } from "../packages/core/src/detect.ts";
import { estimateTokens } from "../packages/core/src/tokens.ts";
import type { GridData, GridHour, ModelClass, UsageEvent } from "../packages/core/src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");

// --- source material --------------------------------------------------------
// Wasteful early, cleaner later, so the weekly card has a real improvement to
// show rather than a fabricated one.

interface Pair {
  prompt: string;
  response: string;
  model_class: ModelClass;
}

const WASTEFUL: Pair[] = [
  {
    prompt: "How much water does a large data center use per day?",
    response:
      "Great question! Published figures for large facilities range from a few hundred thousand to several million gallons a day, depending on the cooling design and the local climate. I hope this helps!",
    model_class: "large",
  },
  {
    prompt: "Why did Virginia become a hub for data centers?",
    response:
      "You asked why Virginia became a hub. Dense fiber routes from the early internet, cheap and reliable power, and county tax incentives all compounded over two decades. Let me know if you have any other questions!",
    model_class: "large",
  },
  {
    prompt: "What is blowdown in a cooling tower?",
    response:
      "Sure, blowdown is the concentrated water a cooling tower flushes out. Minerals build up as water evaporates, so some of it has to be discharged. Blowdown is the concentrated water a cooling tower flushes out.",
    model_class: "large",
  },
  {
    prompt: "Does shortening a prompt reduce emissions?",
    response:
      "Certainly! Only slightly, in fact. Output generation dominates inference energy, so trimming the input mostly saves money rather than power. I hope that helps! Let me know if you want me to go deeper.",
    model_class: "large",
  },
  {
    prompt: "What is the difference between average and marginal carbon intensity?",
    response:
      "The difference between average and marginal carbon intensity is worth being precise about. Average divides total emissions by total generation. Marginal describes the generator that responds to the next unit of demand. I hope this helps!",
    model_class: "large",
  },
  {
    prompt: "Explain why shorter answers save energy.",
    response:
      "Shorter answers use fewer output tokens, which means less energy. Generation happens one token at a time, so each token carries its own cost. Fewer output tokens means shorter answers use less energy. Let me know if you need more detail!",
    model_class: "large",
  },
];

const CLEANER: Pair[] = [
  {
    prompt: "How do evaporative cooling towers use water?",
    response:
      "Warm water from the server loop is sprayed over a fill material while outside air passes through. Part of it evaporates and carries the heat away. The rest returns to the loop, and because evaporation leaves minerals behind, operators periodically flush some out as blowdown.",
    model_class: "medium",
  },
  {
    prompt: "What are the main cooling options for a data center?",
    response:
      "Open evaporative systems are the most water-hungry but very energy efficient. Closed-loop systems recirculate the same fluid and use almost no fresh water. Air cooling avoids water entirely at much higher electricity cost. Direct liquid and immersion cooling put coolant against the chips.",
    model_class: "medium",
  },
  {
    prompt: "What does PUE stand for?",
    response: "Power Usage Effectiveness.",
    model_class: "small",
  },
  {
    prompt: "Translate to French: the grid is clean tonight.",
    response: "Le réseau est propre ce soir.",
    model_class: "small",
  },
  {
    prompt: "Classify this ticket as billing, bug, or question: my card was charged twice.",
    response: "billing",
    model_class: "small",
  },
  {
    prompt: "Summarize this in three bullets: our cooling bill rose 18% after the heatwave.",
    response:
      "- Cooling costs rose 18%\n- The heatwave was the trigger\n- Worth checking setpoints before next summer",
    model_class: "medium",
  },
];

// --- events -----------------------------------------------------------------

const TOTAL_EVENTS = 200;
const DAYS = 30;
const now = new Date();

function isoDaysAgo(days: number, hourOffset: number): string {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  d.setUTCHours((9 + hourOffset) % 24, (hourOffset * 7) % 60, 0, 0);
  return d.toISOString();
}

function buildEvents(): UsageEvent[] {
  const events: UsageEvent[] = [];

  for (let i = 0; i < TOTAL_EVENTS; i++) {
    // 0 = oldest, 1 = newest.
    const progress = i / (TOTAL_EVENTS - 1);
    const daysAgo = Math.round(DAYS * (1 - progress));

    // Waste tapers off over the month: the habit improves as the user applies
    // the instruction block. Deterministic, so re-seeding is reproducible.
    const wastefulChance = 0.85 - 0.7 * progress;
    const useWasteful = pseudoRandom(i) < wastefulChance;
    const pool = useWasteful ? WASTEFUL : CLEANER;
    const pair = pool[i % pool.length]!;

    const result = analyze(pair.response, pair.prompt);
    const inputTokens = estimateTokens(pair.prompt).tokens;

    events.push({
      id: `demo_evt_${String(i).padStart(3, "0")}`,
      timestamp: isoDaysAgo(daysAgo, i % 12),
      surface: "paste",
      tool: i % 3 === 0 ? "claude" : "chatgpt",
      model: pair.model_class,
      model_class: pair.model_class,
      tokens: {
        input: inputTokens,
        cache_write: 0,
        cache_read: 0,
        output: result.totalOutputTokens,
        reasoning: 0,
      },
      token_source: "estimated",
      flags: result.flags,
      region: "PJM",
    });
  }

  return events.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

/** Deterministic pseudo-random in [0,1). Reproducible seeds beat Math.random here. */
function pseudoRandom(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// --- grid -------------------------------------------------------------------

/**
 * A plausible diurnal shape: cleaner overnight when demand falls and wind is
 * typically higher, dirtier through the evening peak.
 *
 * These are SHAPES, not measurements. The numbers exist so the chart and the
 * hour lookup have something to work on before a real EIA key is wired up, and
 * every row is marked source "seeded" for exactly that reason.
 */
function buildGrid(): GridData {
  const hours: GridHour[] = [];
  const start = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  for (let t = start.getTime(); t <= end.getTime(); t += 60 * 60 * 1000) {
    const d = new Date(t);
    const hour = d.getUTCHours();
    // Trough around 04:00 UTC, peak around 19:00 UTC.
    const diurnal = Math.cos(((hour - 19) / 24) * 2 * Math.PI);
    const weekday = d.getUTCDay() === 0 || d.getUTCDay() === 6 ? -25 : 0;
    const centre = 390 + 90 * diurnal + weekday + 20 * (pseudoRandom(t / 3.6e6) - 0.5);

    hours.push({
      hour: d.toISOString(),
      intensity_gco2_per_kwh: {
        low: Math.round(centre * 0.88),
        high: Math.round(centre * 1.12),
        unit: "gCO2/kWh",
      },
      source: "seeded",
    });
  }

  return {
    region: "PJM",
    fetched_at: null,
    hours,
    from_live_api: false,
    note:
      "SEEDED DEMO DATA. Generated by scripts/seed_demo.ts, not from the EIA API. " +
      "Every row is source:\"seeded\" and the UI labels it as such. " +
      "Run `npm run grid` with EIA_API_KEY set to replace this with real hourly data.",
  };
}

// --- tasks and recorded gate runs ------------------------------------------

const TRIAGE_EXAMPLES = [
  { id: "t01", input: "My card was charged twice this month.", expected: "billing" },
  { id: "t02", input: "The export button does nothing on Safari.", expected: "bug" },
  { id: "t03", input: "Do you support SAML single sign-on?", expected: "question" },
  { id: "t04", input: "I was billed after cancelling my plan.", expected: "billing" },
  { id: "t05", input: "Dashboard shows a blank chart after the update.", expected: "bug" },
  { id: "t06", input: "How many seats come with the team plan?", expected: "question" },
  { id: "t07", input: "Refund still has not arrived after two weeks.", expected: "billing" },
  { id: "t08", input: "App crashes when I upload a 40MB file.", expected: "bug" },
  { id: "t09", input: "Can I change my invoice address?", expected: "question" },
  { id: "t10", input: "Charged in USD but my account is in EUR.", expected: "billing" },
];

const SUMMARY_EXAMPLES = [
  {
    id: "s01",
    input: "Customer was double charged in March and is asking for a refund to the original card.",
    expected: "Double charged in March; wants a refund to the original card.",
    key_facts: ["double charged", "March", "refund"],
  },
  {
    id: "s02",
    input: "Export fails on Safari 17 with a console error; works in Chrome.",
    expected: "Export broken on Safari 17, works in Chrome.",
    key_facts: ["Safari", "export", "Chrome"],
  },
  {
    id: "s03",
    input: "Team of 12 wants SAML SSO before renewing in January.",
    expected: "Team of 12 needs SAML SSO before a January renewal.",
    key_facts: ["SAML", "12", "January"],
  },
  {
    id: "s04",
    input: "Upload of a 40MB CSV crashes the app; smaller files are fine.",
    expected: "40MB CSV upload crashes the app; smaller files work.",
    key_facts: ["40MB", "crash", "smaller files"],
  },
  {
    id: "s05",
    input: "Account billed in USD although the workspace region is EUR.",
    expected: "Billed in USD despite an EUR workspace.",
    key_facts: ["USD", "EUR"],
  },
  {
    id: "s06",
    input: "Refund approved on the 3rd but not received after fourteen days.",
    expected: "Refund approved on the 3rd, still not received after 14 days.",
    key_facts: ["refund", "14 days"],
  },
  {
    id: "s07",
    input: "Charts render blank after the 4.2 release for users on Firefox.",
    expected: "Blank charts on Firefox since release 4.2.",
    key_facts: ["blank", "Firefox", "4.2"],
  },
  {
    id: "s08",
    input: "Customer cancelled in June but was charged again in July.",
    expected: "Cancelled in June, charged again in July.",
    key_facts: ["cancelled", "June", "July"],
  },
  {
    id: "s09",
    input: "Asking whether invoice addresses can be edited after issue.",
    expected: "Wants to know if an issued invoice address can be edited.",
    key_facts: ["invoice address", "edit"],
  },
  {
    id: "s10",
    input: "Seat count question: how many seats are included on the team plan.",
    expected: "Asking how many seats the team plan includes.",
    key_facts: ["seats", "team plan"],
  },
];

/**
 * Captured outputs for the gate, keyed `${changeType}:${changeValue}:${exampleId}`.
 *
 * Deliberately NOT all passing. The shortened prompt passes on both tasks; the
 * drop to a small model misses one triage ticket, so the gate blocks it at the
 * 0.95 threshold. A demo where the gate only ever says yes does not demonstrate
 * a gate, and the blocked change is the more convincing half of the story.
 */
function buildRecorded(): Record<string, { output: string; tokens: ReturnType<typeof tokensFor> }> {
  const out: Record<string, { output: string; tokens: ReturnType<typeof tokensFor> }> = {};

  for (const ex of TRIAGE_EXAMPLES) {
    out[`prompt_rewrite:shortened:${ex.id}`] = { output: ex.expected, tokens: tokensFor(3) };
    // t05 is the one the small model gets wrong: a bug report that mentions
    // billing-adjacent words. 9/10 = 0.90, below the 0.95 default.
    out[`model_tier:small:${ex.id}`] = {
      output: ex.id === "t05" ? "question" : ex.expected,
      tokens: tokensFor(3),
    };
  }

  for (const ex of SUMMARY_EXAMPLES) {
    out[`prompt_rewrite:shortened:${ex.id}`] = { output: ex.expected, tokens: tokensFor(18) };
  }

  return out;
}

function tokensFor(output: number) {
  return { input: 60, cache_write: 0, cache_read: 0, output, reasoning: 0 };
}

function buildTasks() {
  return {
    _meta: {
      purpose: "Recurring tasks with hand-written examples, for the quality gate (plan section 7).",
      warning:
        "DEMO DATA. The `recorded` outputs were written for the demo, not captured from a real model. " +
        'Any verdict produced from them is tagged runner_kind:"recorded" and the UI must say so.',
      how_to_make_this_real: "Replace `recorded` with captured outputs from real calls, or implement a live runner (plan item T2-e).",
    },
    tasks: [
      {
        id: "ticket-triage",
        name: "Support ticket triage",
        task_type: "classify",
        match_rule: { kind: "exact" },
        baseline_prompt:
          "You are a support assistant. Please read the following support ticket carefully and classify it. " +
          "Classify the ticket as billing, bug, or question. Explain your reasoning briefly. Thanks!",
        examples: TRIAGE_EXAMPLES,
      },
      {
        id: "ticket-summary",
        name: "Support ticket summary",
        task_type: "summarize",
        match_rule: { kind: "key_facts" },
        baseline_prompt:
          "Please could you summarize the support ticket below for me. " +
          "I would like a summary of the ticket below. Thanks in advance!",
        examples: SUMMARY_EXAMPLES,
      },
    ],
    changes: [
      {
        type: "prompt_rewrite",
        value: "shortened",
        description: "Trimmed politeness and added output directions.",
      },
      {
        type: "model_tier",
        value: "small",
        description: "Run this task on a small model instead.",
      },
    ],
    recorded: buildRecorded(),
  };
}

// --- write ------------------------------------------------------------------

mkdirSync(dataDir, { recursive: true });

const events = buildEvents();
const grid = buildGrid();
const tasks = buildTasks();

write("demo_events.json", {
  _meta: {
    purpose: "Seeded usage history for the weekly card and the dashboard.",
    warning: "DEMO DATA. Generated by scripts/seed_demo.ts. The UI must label it as demo data.",
    note: "Flags were produced by running the real detectors over real text, so these events are consistent with the engine.",
    generated_at: now.toISOString(),
  },
  events,
});
write("grid_pjm.json", grid);
write("demo_tasks.json", tasks);

const wasted = events.reduce(
  (s, e) => s + e.flags.filter((f) => f.confidence === "high").reduce((a, f) => a + f.tokens, 0),
  0,
);
const totalOut = events.reduce((s, e) => s + e.tokens.output, 0);

console.log(`Seeded ${events.length} events over ${DAYS} days`);
console.log(`  output tokens: ${totalOut}, flagged as waste: ${wasted} (${((wasted / totalOut) * 100).toFixed(1)}%)`);
console.log(`Seeded ${grid.hours.length} grid hours, all marked source:"seeded"`);
console.log(`Seeded ${tasks.tasks.length} tasks and ${Object.keys(tasks.recorded).length} recorded gate outputs`);
console.log("\nAll three files are labelled as demo data. The portal shows that label.");

function write(name: string, value: unknown): void {
  writeFileSync(join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  console.log(`wrote data/${name}`);
}
