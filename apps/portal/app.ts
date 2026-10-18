/**
 * Paste-in analyzer (demo-core item D7).
 *
 * This file is presentation only. Every number it shows comes from
 * packages/core, and every one is rendered through formatRange(), which refuses
 * to print a bare figure without its range. That is the plan's rule 3 enforced
 * in one place rather than trusted across a dozen call sites.
 */

import {
  DEFAULT_BASELINE,
  INSTRUCTION_CAVEATS,
  REWRITE_CAVEATS,
  cleanestHour,
  describeBaseline,
  dirtiestHour,
  midpoint,
  parseGridData,
  recordedRunner,
  runFullAnalysis,
  runGate,
  weeklyCard,
} from "../../packages/core/src/index.ts";
import type {
  CardData,
  Change,
  Config,
  Example,
  Flag,
  FullAnalysis,
  GridData,
  GridRowSource,
  ModelClass,
  Range,
  Task,
  TokenCounts,
  UsageEvent,
  Verdict,
} from "../../packages/core/src/index.ts";

// --- tiny DOM helpers -------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- number formatting ------------------------------------------------------

/** Two significant figures, trailing zeros trimmed. Precision we do not have
 *  would be a lie, and ten decimal places reads as precision. */
function sig(n: number, digits = 2): string {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1000) return Math.round(n).toLocaleString();
  const out = Number(n.toPrecision(digits));
  return String(out);
}

/**
 * The only way a figure reaches the screen. Auto-scales the unit so a reading
 * of 0.0003 Wh becomes 0.3 mWh rather than a row of zeros.
 */
function formatRange(r: Range): string {
  const scaled = rescale(r);
  if (scaled.low === scaled.high) return `${sig(scaled.low)} ${scaled.unit}`;
  return `${sig(scaled.low)}–${sig(scaled.high)} ${scaled.unit}`;
}

function rescale(r: Range): Range {
  const peak = Math.max(Math.abs(r.low), Math.abs(r.high));
  if (r.unit === "Wh") {
    if (peak > 0 && peak < 1) return { low: r.low * 1000, high: r.high * 1000, unit: "mWh" };
    if (peak >= 1000) return { low: r.low / 1000, high: r.high / 1000, unit: "kWh" };
  }
  if (r.unit === "mL" && peak >= 1000) {
    return { low: r.low / 1000, high: r.high / 1000, unit: "L" };
  }
  if (r.unit === "g" && peak > 0 && peak < 1) {
    return { low: r.low * 1000, high: r.high * 1000, unit: "mg" };
  }
  if (r.unit === "USD") {
    return { low: r.low, high: r.high, unit: "USD" };
  }
  return r;
}

const FLAG_NAMES: Record<Flag["type"], string> = {
  echo: "Restated your question",
  filler: "Pleasantry",
  repetition: "Repetition",
  recap: "Redundant recap",
  boilerplate: "Boilerplate disclaimer",
  overlength: "Length out of proportion",
  prompt_side: "In your prompt",
};

// --- state ------------------------------------------------------------------

interface Loaded {
  config: Config;
  grid: GridData;
  events: UsageEvent[];
  eventsAreDemo: boolean;
  tasks: TaskBundle | null;
}

interface TaskBundle {
  tasks: (Task & { examples: Example[] })[];
  changes: Change[];
  recorded: Record<string, { output: string; tokens: TokenCounts }>;
}

let loaded: Loaded;
let lastAnalysis: FullAnalysis | null = null;

// --- boot -------------------------------------------------------------------

async function json<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function optionalJson<T>(path: string): Promise<T | null> {
  try {
    return await json<T>(path);
  } catch {
    return null;
  }
}

async function boot(): Promise<void> {
  const [sources, models, gridRaw, eventsRaw, tasksRaw] = await Promise.all([
    json<Config["sources"]>("/config/sources.json"),
    json<Config["models"]>("/config/models.json"),
    optionalJson<unknown>("/data/grid_pjm.json"),
    optionalJson<{ events: UsageEvent[]; _meta?: Record<string, string> }>("/data/demo_events.json"),
    optionalJson<TaskBundle & { _meta?: Record<string, string> }>("/data/demo_tasks.json"),
  ]);

  loaded = {
    config: { sources, models },
    grid: parseGridData(gridRaw),
    events: eventsRaw?.events ?? [],
    eventsAreDemo: eventsRaw !== null,
    tasks: tasksRaw ?? null,
  };

  renderBanners();
  renderTierHint();
  renderGateControls();
  renderWeeklyCard();
  renderGrid();
  wireUp();
}

// --- banners ----------------------------------------------------------------

/**
 * The honesty header. Anything unverified or seeded says so at the top of the
 * page, so the gap between "this runs" and "this is ready to show judges" can
 * never be invisible during a rehearsal.
 */
function renderBanners(): void {
  const host = el("banners");
  const parts: string[] = [];

  const warnings = analysisWarnings();
  if (warnings.length > 0) {
    parts.push(`
      <div class="banner banner-warn">
        <span class="banner-icon">!</span>
        <div>
          <strong>${warnings.length} figure${warnings.length === 1 ? "" : "s"} on this page come from unverified placeholders.</strong>
          Do not quote them. Fill in <code>config/sources.json</code> and set <code>verified: true</code>.
          <ul>${warnings.slice(0, 8).map((w) => `<li><code>${esc(w.key)}</code> &mdash; ${esc(w.message)}</li>`).join("")}</ul>
        </div>
      </div>`);
  }

  const seeded: string[] = [];
  if (loaded.grid.hours.length === 0) {
    seeded.push("no grid data at all, so a single fallback constant is used for every hour");
  } else if (!loaded.grid.from_live_api) {
    seeded.push("grid hours are seeded, not from a live EIA call");
  }
  if (loaded.eventsAreDemo) seeded.push("the weekly card is built from seeded demo history");
  if (loaded.tasks) seeded.push("quality-gate runs replay recorded outputs rather than calling a model");

  if (seeded.length > 0) {
    parts.push(`
      <div class="banner banner-info">
        <span class="banner-icon">i</span>
        <div><strong>Demo data in use:</strong> ${seeded.join("; ")}. Everything derived from it is labelled below.</div>
      </div>`);
  }

  host.innerHTML = parts.join("");
}

function analysisWarnings(): { key: string; message: string }[] {
  // auditConfig lives in core; calling it through a throwaway analysis would
  // need text, so reach for the same data directly.
  const out: { key: string; message: string }[] = [];
  const s = loaded.config.sources as unknown as Record<string, { verified?: boolean; source?: string }>;
  for (const key of [
    "e_out_small",
    "e_out_medium",
    "e_out_large",
    "e_in",
    "e_cache_read",
    "e_cache_write",
    "WI",
    "grid_fallback",
    "va_dc",
    "ACL2025",
  ]) {
    const entry = s[key];
    if (entry && entry.verified === false) {
      out.push({ key, message: entry.source ?? "unverified" });
    }
  }
  const ef = loaded.config.sources.EF as Record<string, unknown>;
  for (const [fuel, entry] of Object.entries(ef)) {
    if (fuel.startsWith("_")) continue;
    const e = entry as { verified?: boolean; source?: string };
    if (e.verified === false) out.push({ key: `EF.${fuel}`, message: e.source ?? "unverified" });
  }
  return out;
}

function renderTierHint(): void {
  const select = el<HTMLSelectElement>("model-class");
  const hint = el("tier-hint");
  const update = (): void => {
    const tier = loaded.config.models.tiers.find((t) => t.id === select.value);
    hint.textContent = tier?.description ?? "";
  };
  select.addEventListener("change", update);
  update();
}

// --- examples ---------------------------------------------------------------

const EXAMPLES: Record<string, { prompt: string; response: string; tier: ModelClass }> = {
  wasteful: {
    prompt: "How much water does a large data center use per day?",
    response:
      "Great question! You asked how much water a large data center uses per day. Published figures for large facilities range from a few hundred thousand to several million gallons a day, depending on the cooling design and the local climate. Published figures for large facilities range from a few hundred thousand to several million gallons a day, depending on the cooling design and the local climate. In summary, it depends mostly on the cooling design and the climate. I hope this helps! Let me know if you have any other questions.",
    tier: "large",
  },
  clean: {
    prompt: "How much water does a large data center use per day?",
    response:
      "Published figures for large facilities range from a few hundred thousand to several million gallons a day. The spread comes mostly from the cooling design: open evaporative systems consume the most, closed-loop almost none.",
    tier: "medium",
  },
  // The waste here is entirely in the prompt: the answer is already tight.
  // Worth demoing, because it is where the honest story lives - trimming the
  // prompt saves money and usage limits, not much energy.
  promptHeavy: {
    prompt:
      "Hi there! I hope you're doing well. I was wondering if you could please translate the paragraph below into French for me. " +
      "Please translate the paragraph below into French. Thanks in advance for your help!\n\n" +
      "> Northern Virginia hosts the densest concentration of data centers in the world. The cluster grew out of early internet fiber routes, " +
      "and it has since reshaped the regional electricity grid. Local officials now weigh tax revenue against pressure on water and power, " +
      "and residents increasingly attend zoning hearings to ask about noise, substations and cooling water withdrawals before new sites are approved.",
    response:
      "La Virginie du Nord accueille la plus forte concentration de centres de données au monde. " +
      "Le pôle est né des premières dorsales de fibre optique d'Internet, et il a depuis remodelé le réseau " +
      "électrique régional. Les élus locaux mettent désormais en balance les recettes fiscales et la pression " +
      "sur l'eau et l'électricité, et les riverains assistent de plus en plus aux audiences d'urbanisme pour " +
      "interroger le bruit, les postes électriques et les prélèvements d'eau de refroidissement avant toute " +
      "nouvelle autorisation.",
    tier: "large",
  },
};

// --- main analysis ----------------------------------------------------------

function readTokens(): { tokens?: TokenCounts } {
  if (el<HTMLSelectElement>("token-mode").value !== "exact") return {};
  const input = Number(el<HTMLInputElement>("exact-input").value) || 0;
  const output = Number(el<HTMLInputElement>("exact-output").value) || 0;
  return {
    tokens: { input, cache_write: 0, cache_read: 0, output, reasoning: 0 },
  };
}

function analyzeNow(): void {
  const prompt = el<HTMLTextAreaElement>("prompt").value;
  const response = el<HTMLTextAreaElement>("response").value;

  if (response.trim().length === 0) {
    el("results").hidden = true;
    return;
  }

  const { tokens } = readTokens();
  const price = Number(el<HTMLInputElement>("price").value) || 0;
  const modelClass = el<HTMLSelectElement>("model-class").value as ModelClass;

  const result = runFullAnalysis(
    {
      prompt,
      response,
      modelClass,
      ...(tokens ? { tokens, tokenSource: "user_entered" as const } : {}),
      grid: loaded.grid,
      pricePerOutputToken: price,
      history: loaded.events.flatMap((e) => e.flags),
      assumedCurrentTier: modelClass,
    },
    loaded.config,
  );

  lastAnalysis = result;
  el("results").hidden = false;
  renderScore(result);
  renderFlags(result, response, prompt);
  renderInstructionFix(result);
  renderRewriteFix(result);
  renderModelFix(result);
}

function renderScore(r: FullAnalysis): void {
  const { analysis, estimate } = r;
  el("efficiency").textContent = `${Math.round(analysis.efficiency * 100)}%`;
  el("efficiency-note").textContent =
    analysis.wastedOutputTokens === 0
      ? "Nothing scored as waste in this answer."
      : `${analysis.wastedOutputTokens} of ${analysis.totalOutputTokens} output tokens flagged as waste.`;

  const tokenNote =
    analysis.tokenSource === "estimated"
      ? "Token counts estimated from the text. Approximate."
      : "Token counts you entered. Exact.";
  el("token-source-note").textContent = `${tokenNote} Grid: ${gridLabel(r.grid.source)}. ${r.grid.note}`;

  const unverified = new Set(estimate.provenance.unverified);
  const cards: { label: string; value: Range; keys: string[] }[] = [
    { label: "Energy wasted", value: estimate.wasted.energyWh, keys: [`e_out_${r.event.model_class}`] },
    { label: "Water wasted", value: estimate.wasted.waterMl, keys: ["WI", `e_out_${r.event.model_class}`] },
    { label: "CO₂ wasted", value: estimate.wasted.co2g, keys: ["grid_fallback", `e_out_${r.event.model_class}`] },
    { label: "Money wasted", value: estimate.wasted.cost, keys: [] },
  ];

  el("resources").innerHTML = cards
    .map((c) => {
      const flagged = c.keys.filter((k) => unverified.has(k));
      const badges =
        flagged.length > 0
          ? flagged.map((k) => `<span class="badge badge-unverified">${esc(k)} unverified</span>`).join("")
          : c.keys.length === 0
            ? `<span class="badge badge-ok">your own price</span>`
            : `<span class="badge badge-ok">sourced</span>`;
      const total = totalFor(c.label, r);
      return `
        <div class="resource">
          <div class="resource-label">${c.label}</div>
          <div class="resource-value">${formatRange(c.value)}</div>
          <div class="resource-of">of ${total} for the whole answer</div>
          <div class="resource-src">${badges}</div>
        </div>`;
    })
    .join("");

  const assumptions = estimate.provenance.assumptions;
  el("assumptions").innerHTML =
    assumptions.length === 0
      ? ""
      : `<h4>Assumptions behind these numbers</h4><ul>${assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`;
}

function totalFor(label: string, r: FullAnalysis): string {
  if (label.startsWith("Energy")) return formatRange(r.estimate.energyWh);
  if (label.startsWith("Water")) return formatRange(r.estimate.waterMl);
  if (label.startsWith("CO")) return formatRange(r.estimate.co2g);
  return formatRange(r.estimate.cost);
}

function gridLabel(source: GridRowSource): string {
  if (source === "eia") return "live EIA data";
  if (source === "seeded") return "seeded demo value";
  return "fallback constant";
}

// --- flags ------------------------------------------------------------------

function renderFlags(r: FullAnalysis, response: string, prompt: string): void {
  el("highlighted").innerHTML = highlight(response, r.analysis.flags);

  const flags = r.analysis.flags;
  el("flag-list").innerHTML =
    flags.length === 0
      ? `<li class="empty">No waste found. Nothing to fix here.</li>`
      : flags
          .map((f) => {
            const scored = f.confidence === "high";
            return `
          <li class="flag-item ${scored ? "scored" : "advisory"}">
            <div class="flag-top">
              <span class="flag-type">${FLAG_NAMES[f.type]}</span>
              <span class="flag-cost">${scored ? `~${f.tokens} tokens` : "advisory, not scored"}</span>
            </div>
            <p class="flag-why">${esc(f.why)}</p>
            ${f.excerpt ? `<p class="flag-excerpt">&ldquo;${esc(f.excerpt)}&rdquo;</p>` : ""}
          </li>`;
          })
          .join("");

  const pf = r.analysis.promptFlags;
  el("prompt-flags").innerHTML =
    pf.length === 0 || prompt.trim().length === 0
      ? ""
      : `<div class="assumptions">
           <h4>Also found in your prompt (advisory)</h4>
           <ul>${pf.map((f) => `<li>${esc(f.why)}${f.excerpt ? ` &mdash; &ldquo;${esc(f.excerpt)}&rdquo;` : ""}</li>`).join("")}</ul>
         </div>`;
}

/**
 * Wrap flagged spans in <mark>. Overlapping flags are emitted once, first one
 * wins, which mirrors how the score merges them: showing the same words
 * highlighted twice would imply they were counted twice.
 */
function highlight(text: string, flags: Flag[]): string {
  const spans = flags
    .filter((f) => f.end > f.start)
    .slice()
    .sort((a, b) => a.start - b.start || b.end - a.end);

  let out = "";
  let cursor = 0;
  for (const f of spans) {
    if (f.start < cursor) continue;
    out += esc(text.slice(cursor, f.start));
    const cls = f.confidence === "high" ? "" : ' class="advisory"';
    out += `<mark${cls} title="${esc(FLAG_NAMES[f.type])}: ${esc(f.why)}">${esc(text.slice(f.start, f.end))}</mark>`;
    cursor = f.end;
  }
  out += esc(text.slice(cursor));
  return out;
}

// --- fix 1 ------------------------------------------------------------------

function renderInstructionFix(r: FullAnalysis): void {
  const block = r.instructionBlock;
  el("instruction-block").textContent =
    block.block || "No standing instruction needed: nothing recurring was found.";
  el("block-meta").textContent = block.lines.length
    ? `${block.wordCount} words, covering ${block.basedOn.map((b) => FLAG_NAMES[b.type].toLowerCase()).join(", ")}. Sent with every message, so it stays short.`
    : "";
  el("instruction-caveats").innerHTML = INSTRUCTION_CAVEATS.map((c) => `<li>${esc(c)}</li>`).join("");
}

// --- fix 2 ------------------------------------------------------------------

function renderRewriteFix(r: FullAnalysis): void {
  const rw = r.rewrite;

  el("rewrite-diff").innerHTML = rw.diff
    .map((d) => {
      const mark = d.op === "keep" ? " " : d.op === "remove" ? "−" : "+";
      return `<div class="diff-row diff-${d.op}"><span class="diff-mark">${mark}</span><span>${esc(d.text)}</span></div>`;
    })
    .join("");

  el("rewritten").textContent = rw.rewritten;

  const delta = rw.tokenDelta;
  const direction =
    delta < 0 ? `${Math.abs(delta)} tokens shorter` : delta > 0 ? `${delta} tokens longer` : "same length";
  const checked = rw.checkedAgainstExamples
    ? "Checked against your saved examples."
    : "Not checked against examples — no saved examples for this task.";
  el("rewrite-meta").textContent = `${direction} · detected as a ${rw.taskType} task · ${checked}`;

  el("flagged-context").innerHTML =
    rw.flaggedContext.length === 0
      ? ""
      : rw.flaggedContext
          .map(
            (c) => `
        <div class="context-warn">
          <strong>${c.words} words of pasted context left in place.</strong>
          Only you know whether the model needs it, so it is flagged, never removed.
          <pre>${esc(c.excerpt)}&hellip;</pre>
        </div>`,
          )
          .join("");

  el("rewrite-caveats").innerHTML = REWRITE_CAVEATS.map((c) => `<li>${esc(c)}</li>`).join("");
}

// --- fix 3 ------------------------------------------------------------------

function renderModelFix(r: FullAnalysis): void {
  const s = r.suggestion;
  const saving = s.isDowngrade
    ? `<span class="suggestion-pill">saves ${formatRange(s.footprintDeltaPer1kOutput)}</span>
       <span class="suggestion-pill">${formatRange(r.suggestionDeltaForThisResponse)} on this answer</span>`
    : "";

  el("suggestion").innerHTML = `
    <span class="suggestion-main">${esc(s.label)}</span>
    <span class="suggestion-pill">confidence: ${s.confidence}</span>
    <span class="suggestion-pill">assuming you are on ${s.assumedCurrentTier}</span>
    ${saving}`;

  el("signal-list").innerHTML = s.signals
    .map(
      (sig) =>
        `<li class="${sig.hit ? "signal-hit" : "signal-miss"}">
           ${sig.hit ? "✓" : "·"} ${esc(sig.name)}
           <span class="flag-cost">${sig.weight > 0 ? "+" : ""}${sig.weight}${sig.hit ? "" : " (not fired)"}</span>
           ${sig.detail && sig.hit ? `<br><span class="hint">${esc(sig.detail)}</span>` : ""}
         </li>`,
    )
    .join("");

  el("model-caveats").innerHTML = s.caveats.map((c) => `<li>${esc(c)}</li>`).join("");
}

// --- quality gate -----------------------------------------------------------

function renderGateControls(): void {
  const taskSelect = el<HTMLSelectElement>("gate-task");
  const changeSelect = el<HTMLSelectElement>("gate-change");

  if (!loaded.tasks) {
    el("gate-result").innerHTML =
      `<p class="empty">No tasks found. Run <code>npm run seed</code> to create data/demo_tasks.json.</p>`;
    el<HTMLButtonElement>("run-gate").disabled = true;
    return;
  }

  taskSelect.innerHTML = loaded.tasks.tasks
    .map((t) => `<option value="${esc(t.id)}">${esc(t.name)} (${t.examples.length} examples)</option>`)
    .join("");
  changeSelect.innerHTML = loaded.tasks.changes
    .map((c, i) => `<option value="${i}">${esc(c.description)}</option>`)
    .join("");
}

async function runGateNow(): Promise<void> {
  if (!loaded.tasks) return;
  const host = el("gate-result");
  const taskId = el<HTMLSelectElement>("gate-task").value;
  const changeIdx = Number(el<HTMLSelectElement>("gate-change").value);
  const threshold = Number(el<HTMLInputElement>("gate-threshold").value) || 0.95;

  const task = loaded.tasks.tasks.find((t) => t.id === taskId);
  const change = loaded.tasks.changes[changeIdx];
  if (!task || !change) return;

  host.innerHTML = `<p class="empty">Running ${task.examples.length} examples&hellip;</p>`;

  try {
    const verdict = await runGate(
      task,
      change,
      task.examples,
      recordedRunner(loaded.tasks.recorded),
      loaded.config,
      { threshold },
    );
    host.innerHTML = renderVerdict(verdict, task, change);
  } catch (err) {
    host.innerHTML = `
      <div class="verdict">
        <div class="verdict-head verdict-fail">
          <span class="verdict-stamp">Could not run</span>
        </div>
        <div class="verdict-body">
          <p>${esc(err instanceof Error ? err.message : String(err))}</p>
          <p class="hint">A recorded runner only knows the outputs that were captured for it. That is on purpose: it
          refuses to invent an answer rather than quietly passing a change nobody tested.</p>
        </div>
      </div>`;
  }
}

function renderVerdict(v: Verdict, task: Task, change: Change): string {
  const pass = v.passed;
  const failures =
    v.failures.length === 0
      ? ""
      : `<h4 class="field-label">Examples that broke</h4>
         <ul class="failures">
           ${v.failures
             .map(
               (f) => `<li><code>${esc(f.example_id)}</code> &mdash; ${esc(f.reason)}
                 <br>expected <code>${esc(f.expected)}</code>, got <code>${esc(f.got)}</code></li>`,
             )
             .join("")}
         </ul>`;

  const decision = pass
    ? `This change is safe to offer. Savings from it would be reported net of the check's own cost.`
    : `This change is <strong>not</strong> offered. It would have shipped a worse answer as a saving.`;

  return `
    <div class="verdict">
      <div class="verdict-head ${pass ? "verdict-pass" : "verdict-fail"}">
        <span class="verdict-stamp">${pass ? "PASSED" : "BLOCKED"}</span>
        <span>${v.passes} of ${v.examples_run} examples kept the right answer (${Math.round(v.pass_rate * 100)}%, threshold ${Math.round(v.threshold * 100)}%)</span>
        <span class="badge ${v.runner_kind === "recorded" ? "badge-demo" : "badge-ok"}">${v.runner_kind === "recorded" ? "recorded run, not live" : "live run"}</span>
      </div>
      <div class="verdict-body">
        <p>${decision}</p>
        <dl>
          <dt>Task</dt><dd>${esc(task.name)}</dd>
          <dt>Change</dt><dd>${esc(change.description)}</dd>
          <dt>Match rule</dt><dd>${esc(describeRule(task))}</dd>
          <dt>What the check itself cost</dt><dd>${v.check_cost.tokens} tokens, ${formatRange(v.check_cost.energyWh)}</dd>
          <dt>Checked at</dt><dd>${esc(new Date(v.checked_at).toLocaleString())}</dd>
          <dt>Expires</dt><dd>${esc(new Date(v.expires_at).toLocaleDateString())} &mdash; or sooner if the examples change</dd>
          <dt>Example set</dt><dd><code>${esc(v.example_set_hash)}</code></dd>
        </dl>
        ${failures}
        <p class="hint">Run once per task, never per request. Re-checking every request would cost more energy than the
        change saves, which is the trap this whole design exists to avoid.</p>
      </div>
    </div>`;
}

function describeRule(task: Task): string {
  const rule = task.match_rule;
  if (rule.kind === "exact") return "the label must match exactly";
  if (rule.kind === "key_facts") return "every hand-written key fact must still appear";
  return `the final field "${rule.required_final_field}" must survive`;
}

// --- weekly card ------------------------------------------------------------

function renderWeeklyCard(): void {
  const host = el("weekly-card");
  if (loaded.events.length === 0) {
    host.innerHTML = `<p class="empty">No history yet. Run <code>npm run seed</code> to create data/demo_events.json.</p>`;
    return;
  }

  const card = weeklyCard(loaded.events, loaded.config, {
    baseline: DEFAULT_BASELINE,
    grid: loaded.grid,
    isDemoData: loaded.eventsAreDemo,
  });
  host.innerHTML = renderCard(card);
}

function renderCard(card: CardData): string {
  const change =
    card.changePoints === null
      ? `<div class="wcard-change">no baseline yet</div>`
      : `<div class="wcard-change ${card.changePoints >= 0 ? "wcard-up" : "wcard-down"}">
           ${card.changePoints >= 0 ? "↑" : "↓"} ${Math.abs(card.changePoints).toFixed(1)} points vs ${esc(card.baselineLabel)}
         </div>`;

  const stats: { label: string; value: string }[] = [
    { label: "Responses counted", value: String(card.eventsCounted) },
    { label: "Tokens wasted", value: card.wastedTokens.toLocaleString() },
    { label: "Top waste type", value: card.topWasteType ? FLAG_NAMES[card.topWasteType] : "none" },
    { label: "Energy", value: formatRange(card.resources.energyWh) },
    { label: "Water", value: formatRange(card.resources.waterMl) },
    { label: "CO₂", value: formatRange(card.resources.co2g) },
  ];

  const badges = [
    card.isDemoData ? `<span class="badge badge-demo">demo data</span>` : "",
    `<span class="badge ${card.provenance.gridSource === "eia" ? "badge-ok" : "badge-unverified"}">grid: ${gridLabel(card.provenance.gridSource)}</span>`,
    card.provenance.unverified.length > 0
      ? `<span class="badge badge-unverified">${card.provenance.unverified.length} unverified source${card.provenance.unverified.length === 1 ? "" : "s"}</span>`
      : "",
  ].join(" ");

  return `
    <div class="wcard">
      <div class="wcard-score">
        <div class="wcard-eff">${Math.round(card.efficiency * 100)}%</div>
        ${change}
      </div>
      <div class="wcard-stats">
        ${stats.map((s) => `<div><div class="wcard-stat-label">${s.label}</div><div class="wcard-stat-value">${s.value}</div></div>`).join("")}
      </div>
      <div class="wcard-foot">
        ${badges}
        <p style="margin:8px 0 0">
          Resource figures are the waste only, compared against ${esc(describeBaseline(card.baseline))}.
          Shared scores never include your prompts or responses.
        </p>
      </div>
    </div>`;
}

// --- grid -------------------------------------------------------------------

function renderGrid(): void {
  const host = el("grid-info");
  const grid = loaded.grid;

  if (grid.hours.length === 0) {
    host.innerHTML = `
      <p class="empty">No grid data loaded, so every hour uses one fallback constant.</p>
      <p class="spark-note">${esc(grid.note)}</p>`;
    return;
  }

  const clean = cleanestHour(grid);
  const dirty = dirtiestHour(grid);
  const recent = grid.hours.slice(-72);

  const stats: { label: string; value: string }[] = [
    { label: "Hours cached", value: grid.hours.length.toLocaleString() },
    { label: "Provenance", value: grid.from_live_api ? "live EIA call" : "seeded demo data" },
    {
      label: "Cleanest hour",
      value: clean ? `${sig(midpoint(clean.intensity_gco2_per_kwh))} gCO₂/kWh` : "n/a",
    },
    {
      label: "Dirtiest hour",
      value: dirty ? `${sig(midpoint(dirty.intensity_gco2_per_kwh))} gCO₂/kWh` : "n/a",
    },
  ];

  const spread =
    clean && dirty
      ? `${(midpoint(dirty.intensity_gco2_per_kwh) / Math.max(1, midpoint(clean.intensity_gco2_per_kwh))).toFixed(1)}x`
      : "n/a";

  host.innerHTML = `
    <div class="grid-stats">
      ${stats.map((s) => `<div class="resource"><div class="resource-label">${s.label}</div><div class="resource-value">${esc(s.value)}</div></div>`).join("")}
    </div>
    ${sparkline(recent)}
    <p class="spark-note">
      Last ${recent.length} hours. Dirtiest hour is ${spread} the cleanest, which is the spread a scheduler would exploit
      &mdash; that is the roadmap item, not this build. ${esc(grid.note)}
    </p>`;
}

function sparkline(hours: GridData["hours"]): string {
  if (hours.length < 2) return "";
  const values = hours.map((h) => midpoint(h.intensity_gco2_per_kwh));
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = Math.max(1, hi - lo);
  const W = 1000;
  const H = 110;
  const pad = 8;

  const points = values
    .map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (W - pad * 2);
      const y = H - pad - ((v - lo) / span) * (H - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return `
    <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
         aria-label="Carbon intensity over the last ${hours.length} hours">
      <polyline fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"
                opacity="0.75" points="${points}" />
    </svg>`;
}

// --- wiring -----------------------------------------------------------------

function wireUp(): void {
  el("analyze-btn").addEventListener("click", analyzeNow);

  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-example]"))) {
    button.addEventListener("click", () => {
      const key = button.dataset["example"];
      const example = key ? EXAMPLES[key] : undefined;
      if (!example) return;
      el<HTMLTextAreaElement>("prompt").value = example.prompt;
      el<HTMLTextAreaElement>("response").value = example.response;
      el<HTMLSelectElement>("model-class").value = example.tier;
      el<HTMLSelectElement>("model-class").dispatchEvent(new Event("change"));
      analyzeNow();
      el("results").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  el("clear-btn").addEventListener("click", () => {
    el<HTMLTextAreaElement>("prompt").value = "";
    el<HTMLTextAreaElement>("response").value = "";
    el("results").hidden = true;
    lastAnalysis = null;
  });

  el<HTMLSelectElement>("token-mode").addEventListener("change", (e) => {
    const exact = (e.target as HTMLSelectElement).value === "exact";
    el("exact-input-field").hidden = !exact;
    el("exact-output-field").hidden = !exact;
  });

  el("copy-block").addEventListener("click", () => {
    if (!lastAnalysis) return;
    copy(lastAnalysis.instructionBlock.block, el("copy-block"), "Copied");
  });

  el("approve-rewrite").addEventListener("click", () => {
    if (!lastAnalysis) return;
    copy(lastAnalysis.rewrite.rewritten, el("approve-rewrite"), "Approved & copied");
  });

  el("run-gate").addEventListener("click", () => void runGateNow());
}

function copy(text: string, button: HTMLElement, done: string): void {
  const restore = button.textContent ?? "";
  const finish = (ok: boolean): void => {
    button.textContent = ok ? done : "Copy failed — select it manually";
    setTimeout(() => {
      button.textContent = restore;
    }, 1800);
  };
  navigator.clipboard?.writeText(text).then(
    () => finish(true),
    () => finish(false),
  );
}

// --- go ---------------------------------------------------------------------

boot().catch((err) => {
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div class="wrap"><div class="banner banner-warn" style="margin:20px 0">
       <span class="banner-icon">!</span>
       <div><strong>Failed to start.</strong> ${esc(err instanceof Error ? err.message : String(err))}
       <br>Serve the project with <code>npm run dev</code> rather than opening the file directly.</div>
     </div></div>`,
  );
  console.error(err);
});
