import {
  LEADERBOARD_MIN_REPLIES,
  cleanAlias,
  defaultAlias,
  estimateTokens,
  parseGridData,
  rewritePrompt,
  runFullAnalysis,
  suggestModel,
  syncUsageEvent,
  type Config,
  type FullAnalysis,
  type GridData,
  type LeaderboardEntry,
  type ModelClass,
  type Range,
  type SyncUsageEvent,
} from "../../packages/core/src/index.ts";
import {
  createAccount,
  initializeFirebase,
  loadAlias,
  loadLeaderboard,
  observeEvents,
  observeUser,
  publishLeaderboard,
  saveAlias,
  saveEvent,
  signIn,
  signOut,
  type FirebaseWebConfig,
  type PortalUser,
} from "./firebase.ts";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function json<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

let config: Config;
let grid: GridData;
let user: PortalUser | null = null;
let events: SyncUsageEvent[] = [];
let stopEvents: (() => void) | null = null;
let authMode: "signin" | "signup" = "signin";
let latestRewrite = "";
let alias = "";
let board: LeaderboardEntry[] = [];

const VIEW_COPY: Record<string, { title: string; kicker: string }> = {
  overview: { title: "Overview", kicker: "Unified intelligence" },
  analyzer: { title: "Analyzer", kicker: "Before you spend" },
  leaderboard: { title: "Leaderboard", kicker: "Public efficiency ranking" },
  connections: { title: "Connections", kicker: "One account, every surface" },
};

async function boot(): Promise<void> {
  try {
    const [sources, models, gridRaw, firebaseConfig] = await Promise.all([
      json<Config["sources"]>("/config/sources.json"),
      json<Config["models"]>("/config/models.json"),
      json<unknown>("/data/grid_pjm.json").catch(() => null),
      json<FirebaseWebConfig>("/config/firebase.json"),
    ]);
    config = { sources, models };
    grid = parseGridData(gridRaw);
    if (new URLSearchParams(location.search).has("preview")) {
      wireUi();
      el("setup-screen").hidden = true;
      el("auth-screen").hidden = true;
      el("app-shell").hidden = false;
      el("user-email").textContent = "Preview account";
      el("user-avatar").textContent = "P";
      el("sync-label").textContent = "Preview mode";
      renderDashboard();
      return;
    }
    await initializeFirebase(firebaseConfig);
    wireUi();
    el("setup-screen").hidden = true;
    observeUser(handleUser);
  } catch (error) {
    el("setup-kicker").textContent = "Setup required";
    el("setup-title").textContent = "Connect your Firebase project";
    el("setup-message").textContent = error instanceof Error ? error.message : String(error);
    el("setup-command").hidden = false;
    el("setup-screen").hidden = false;
  }
}

function handleUser(next: PortalUser | null): void {
  user = next;
  stopEvents?.();
  stopEvents = null;
  if (!user) {
    events = [];
    el("app-shell").hidden = true;
    el("auth-screen").hidden = false;
    return;
  }
  el("auth-screen").hidden = true;
  el("app-shell").hidden = false;
  el("user-email").textContent = user.email;
  el("user-avatar").textContent = user.email.slice(0, 1).toUpperCase();
  alias = defaultAlias(user.uid);
  el<HTMLInputElement>("alias-input").value = "";
  void loadAlias(user.uid)
    .then((saved) => {
      if (!saved) return;
      alias = saved;
      el<HTMLInputElement>("alias-input").value = saved;
    })
    .catch(() => undefined);
  stopEvents = observeEvents(user.uid, (nextEvents) => {
    events = nextEvents;
    renderDashboard();
    // Publishing on every refresh keeps the public row honest when the
    // extension or CLI added events while this tab was open.
    void syncLeaderboardRow();
  });
  void refreshLeaderboard();
}

/**
 * Push this account's public row, then reload the board.
 *
 * Only the portal writes a leaderboard row: it is the one surface that has the
 * whole event list, so it is the only one whose total can be right.
 */
async function syncLeaderboardRow(): Promise<void> {
  if (!user || events.length === 0) return;
  try {
    await publishLeaderboard(user.uid, alias, events);
  } catch (error) {
    console.error("Publishing your leaderboard row failed", error);
  }
}

async function refreshLeaderboard(): Promise<void> {
  try {
    board = await loadLeaderboard();
    renderLeaderboard();
  } catch (error) {
    el("leaderboard-note").textContent =
      error instanceof Error ? error.message : "The leaderboard could not be loaded.";
  }
}

function renderLeaderboard(): void {
  const rows = board;
  el("leaderboard-empty").hidden = rows.length > 0;
  el("leaderboard-note").textContent =
    `Public ranking. Shows accounts with at least ${LEADERBOARD_MIN_REPLIES} measured replies. Aliases and totals only, never conversation text.`;
  el<HTMLTableSectionElement>("leaderboard-rows").innerHTML = rows
    .map((row, index) => {
      const mine = row.uid === user?.uid;
      const saved = (row.savedEnergyWhLow + row.savedEnergyWhHigh) / 2;
      return `<tr class="${mine ? "is-me" : ""}"><td><strong>${index + 1}</strong></td><td>${esc(row.alias)}${mine ? ' <span class="source-chip paste">you</span>' : ""}</td><td><strong>${Math.round(row.efficiency * 100)}%</strong></td><td>${row.replies.toLocaleString()}</td><td>${resource(saved, "Wh")}</td><td>${row.surfaces.map((s) => `<span class="source-chip ${esc(s)}">${esc(s)}</span>`).join(" ")}</td></tr>`;
    })
    .join("");
}

async function submitAlias(): Promise<void> {
  if (!user) return;
  const button = el<HTMLButtonElement>("save-alias");
  const raw = el<HTMLInputElement>("alias-input").value;
  const next = cleanAlias(raw, user.uid);
  button.disabled = true;
  try {
    await saveAlias(user.uid, next);
    alias = next;
    el<HTMLInputElement>("alias-input").value = next;
    await syncLeaderboardRow();
    await refreshLeaderboard();
    showToast(`Leaderboard name set to ${next}`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
  }
}

function wireUi(): void {
  el<HTMLFormElement>("auth-form").addEventListener("submit", (event) => void submitAuth(event));
  el("auth-switch").addEventListener("click", toggleAuthMode);
  el("sign-out").addEventListener("click", () => void signOut());
  document.querySelectorAll<HTMLElement>("[data-view]").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view ?? "overview"));
  });
  document.querySelectorAll<HTMLElement>("[data-view-jump]").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.viewJump ?? "overview"));
  });
  el("analyze-btn").addEventListener("click", () => void analyze());
  el("copy-rewrite").addEventListener("click", () => void copy(latestRewrite, "Improved prompt copied"));
  el("save-alias").addEventListener("click", () => void submitAlias());
  el("refresh-leaderboard").addEventListener("click", () => void refreshLeaderboard());
  document.querySelector(".copy-command")?.addEventListener("click", () => {
    void copy(el("cli-command").textContent ?? "", "CLI command copied");
  });
}

async function submitAuth(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const email = el<HTMLInputElement>("auth-email").value.trim();
  const password = el<HTMLInputElement>("auth-password").value;
  const error = el("auth-error");
  const submit = el<HTMLButtonElement>("auth-submit");
  error.textContent = "";
  submit.disabled = true;
  submit.textContent = authMode === "signin" ? "Signing in…" : "Creating account…";
  try {
    if (authMode === "signin") await signIn(email, password);
    else await createAccount(email, password);
  } catch (reason) {
    error.textContent = reason instanceof Error ? reason.message : String(reason);
  } finally {
    submit.disabled = false;
    submit.textContent = authMode === "signin" ? "Sign in" : "Create account";
  }
}

function toggleAuthMode(): void {
  authMode = authMode === "signin" ? "signup" : "signin";
  const signup = authMode === "signup";
  el("auth-title").textContent = signup ? "Create your account" : "Welcome back";
  el("auth-subtitle").textContent = signup ? "Start one private footprint across every AI workflow." : "Sign in to see your footprint across every connected tool.";
  el("auth-submit").textContent = signup ? "Create account" : "Sign in";
  el("auth-switch").textContent = signup ? "Already have an account? Sign in" : "Need an account? Create one";
  el<HTMLInputElement>("auth-password").autocomplete = signup ? "new-password" : "current-password";
  el("auth-error").textContent = "";
}

function showView(name: string): void {
  const safe = VIEW_COPY[name] ? name : "overview";
  document.querySelectorAll(".view").forEach((node) => node.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach((node) => node.classList.remove("active"));
  el(`view-${safe}`).classList.add("active");
  document.querySelector(`[data-view="${safe}"]`)?.classList.add("active");
  el("view-title").textContent = VIEW_COPY[safe]!.title;
  el("view-kicker").textContent = VIEW_COPY[safe]!.kicker;
  history.replaceState(null, "", `#${safe}`);
}

function midpoint(range: Range): number {
  return (range.low + range.high) / 2;
}

function compact(value: number): string {
  return new Intl.NumberFormat("en", { notation: value >= 1000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function resource(value: number, unit: string): string {
  if (value > 0 && value < 1 && unit === "Wh") return `${(value * 1000).toFixed(1)} mWh`;
  return `${compact(value)} ${unit}`;
}

function renderDashboard(): void {
  const total = events.reduce((sum, event) => sum + event.totalOutputTokens, 0);
  const wasted = events.reduce((sum, event) => sum + event.wastedOutputTokens, 0);
  const efficiency = total > 0 ? 1 - wasted / total : null;
  const energy = events.reduce((sum, event) => sum + midpoint(event.resources.wasted.energyWh), 0);
  el("metric-efficiency").textContent = efficiency === null ? "—" : `${Math.round(efficiency * 100)}%`;
  el("metric-efficiency-note").textContent = efficiency === null ? "Waiting for your first analysis" : `${wasted.toLocaleString()} of ${total.toLocaleString()} tokens flagged`;
  el("metric-responses").textContent = events.length.toLocaleString();
  el("metric-waste").textContent = wasted.toLocaleString();
  el("metric-energy").textContent = resource(energy, "Wh");
  renderTrend();
  renderSources();
  renderRecent();
}

function renderTrend(): void {
  const host = el("trend-chart");
  const days = Array.from({ length: 14 }, (_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (13 - index));
    return { key: date.toISOString().slice(0, 10), label: date.toLocaleDateString("en", { weekday: "short" }), events: [] as SyncUsageEvent[] };
  });
  for (const event of events) {
    const bucket = days.find((day) => day.key === event.timestamp.slice(0, 10));
    bucket?.events.push(event);
  }
  const values = days.map((day) => {
    const total = day.events.reduce((sum, event) => sum + event.totalOutputTokens, 0);
    const waste = day.events.reduce((sum, event) => sum + event.wastedOutputTokens, 0);
    return total > 0 ? Math.round((1 - waste / total) * 100) : null;
  });
  host.innerHTML = `<div class="chart-grid">${[100, 75, 50, 25].map((n) => `<span style="bottom:${n}%"><b>${n}%</b></span>`).join("")}</div><div class="chart-bars">${values.map((value, index) => `<div class="chart-day" title="${value ?? "No data"}${value === null ? "" : "% efficient"}"><i style="height:${value ?? 2}%" class="${value === null ? "empty" : ""}"></i><small>${index % 2 === 0 ? days[index]!.label : ""}</small></div>`).join("")}</div>`;
}

function renderSources(): void {
  const count = new Map<string, number>();
  for (const event of events) count.set(event.surface, (count.get(event.surface) ?? 0) + 1);
  const labels: Record<string, string> = { web: "Browser extension", cli: "Terminal CLI", paste: "Web analyzer" };
  const colors: Record<string, string> = { web: "#29d7c8", cli: "#77a7ff", paste: "#d8ff66" };
  const total = Math.max(1, events.length);
  el("source-breakdown").innerHTML = ["web", "cli", "paste"].map((source) => {
    const value = count.get(source) ?? 0;
    const percent = Math.round(value / total * 100);
    return `<div class="source-row"><div><i style="background:${colors[source]}"></i><span>${labels[source]}</span><strong>${value}</strong></div><span class="source-track"><i style="width:${percent}%;background:${colors[source]}"></i></span></div>`;
  }).join("");
}

function renderRecent(): void {
  const recent = events.slice(0, 12);
  el("events-empty").hidden = recent.length > 0;
  el<HTMLTableSectionElement>("recent-events").innerHTML = recent.map((event) => {
    const when = new Date(event.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return `<tr><td><span class="source-chip ${event.surface}">${esc(event.surface)}</span></td><td>${esc(event.tool)}</td><td><strong>${Math.round(event.efficiency * 100)}%</strong></td><td>${event.totalOutputTokens.toLocaleString()}</td><td>${event.wastedOutputTokens.toLocaleString()}</td><td>${esc(when)}</td></tr>`;
  }).join("");
}

async function analyze(): Promise<void> {
  const prompt = el<HTMLTextAreaElement>("prompt").value.trim();
  const response = el<HTMLTextAreaElement>("response").value.trim();
  const modelClass = el<HTMLSelectElement>("model-class").value as ModelClass;
  const tool = el<HTMLInputElement>("tool-name").value.trim() || "Unsupported AI tool";
  const error = el("analyzer-error");
  error.textContent = "";
  if (!prompt) {
    error.textContent = "Paste a prompt first.";
    return;
  }

  const rewrite = rewritePrompt(prompt);
  const suggestion = suggestModel(prompt, config, modelClass);
  latestRewrite = rewrite.rewritten;
  el("analysis-empty").hidden = true;
  el("analysis-content").hidden = false;
  el("rewrite-result").textContent = rewrite.rewritten;
  el("model-result").textContent = suggestion.label;
  const before = estimateTokens(prompt).tokens;
  const after = estimateTokens(rewrite.rewritten).tokens;
  el("detect-result").textContent = rewrite.removed.length > 0 ? `${rewrite.removed.length} unnecessary section${rewrite.removed.length === 1 ? "" : "s"} detected. Revised prompt: ${before} → ${after} estimated tokens.` : `The request is already focused. We added an output-control instruction to reduce response waste.`;

  if (!response) {
    el("result-efficiency").textContent = "Prompt only";
    el("result-summary").textContent = "Suggestions are ready before you spend any tokens.";
    el("measure-result").textContent = "Paste the AI response to calculate tokens, energy, water, CO₂, and cost.";
    showToast("Prompt analyzed locally. Add a response to save a usage event.");
    return;
  }

  const result = runFullAnalysis({ prompt, response, modelClass, grid, assumedCurrentTier: modelClass, surface: "paste", tool }, config);
  renderAnalysis(result);
  if (!user) return;
  const record = syncUsageEvent({
    id: result.event.id,
    timestamp: result.event.timestamp,
    surface: "paste",
    tool,
    modelClass,
    tokens: result.event.tokens,
    totalOutputTokens: result.analysis.totalOutputTokens,
    wastedOutputTokens: result.analysis.wastedOutputTokens,
    efficiency: result.analysis.efficiency,
    flags: result.analysis.flags,
    estimate: result.estimate,
  });
  el("sync-label").textContent = "Saving…";
  try {
    await saveEvent(user.uid, record);
    events = [record, ...events];
    renderDashboard();
    el("sync-label").textContent = "Live sync";
    showToast("Analysis saved to your unified dashboard");
    await syncLeaderboardRow();
    await refreshLeaderboard();
  } catch (reason) {
    el("sync-label").textContent = "Sync error";
    error.textContent = reason instanceof Error ? reason.message : String(reason);
  }
}

function renderAnalysis(result: FullAnalysis): void {
  const pct = Math.round(result.analysis.efficiency * 100);
  el("result-efficiency").textContent = `${pct}%`;
  el("result-summary").textContent = `${result.analysis.wastedOutputTokens} of ${result.analysis.totalOutputTokens} output tokens were flagged as avoidable.`;
  const energy = result.estimate.wasted.energyWh;
  const water = result.estimate.wasted.waterMl;
  const co2 = result.estimate.wasted.co2g;
  el("measure-result").textContent = `Estimated waste: ${rangeText(energy)} energy, ${rangeText(water)} water, and ${rangeText(co2)} CO₂.`;
  const names: Record<string, string> = { echo: "question restatement", filler: "filler", repetition: "repetition", recap: "redundant recap", boilerplate: "boilerplate", overlength: "excess length" };
  const findings = result.analysis.flags.map((flag) => names[flag.type] ?? flag.type);
  el("detect-result").textContent = findings.length ? `Detected ${[...new Set(findings)].join(", ")}.` : "No high-confidence output waste was detected.";
}

function rangeText(range: Range): string {
  const digits = range.high < 1 ? 3 : 1;
  return `${range.low.toFixed(digits)}–${range.high.toFixed(digits)} ${range.unit}`;
}

async function copy(value: string, message: string): Promise<void> {
  await navigator.clipboard.writeText(value);
  showToast(message);
}

let toastTimer: number | undefined;
function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  const toast = el("toast");
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3200);
}

void boot();
