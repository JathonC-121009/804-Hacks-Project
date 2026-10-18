/**
 * Content script: the part of the product that actually prevents waste.
 *
 * The paste-in portal can only ever tell you what a reply already cost. By then
 * the tokens are spent. This runs in the page, so the prompt rewrite and the
 * model suggestion arrive BEFORE you press send, which is the only moment they
 * are worth anything.
 *
 * Two jobs:
 *   1. pre-send nudge  - watch the composer, offer a shorter prompt and a
 *                        lighter model while the prompt is still a draft;
 *   2. reply receipt   - when an answer finishes, show what it cost and which
 *                        parts of it were waste.
 *
 * Privacy, which is also the pitch: every byte of text analysis happens here.
 * Prompt and response text are never stored or transmitted. Aggregate counts
 * stay local unless the user explicitly connects account sync.
 */

import type {
  Config,
  Estimate,
  Flag,
  ModelClass,
  Range,
  WasteProfile,
} from "../../packages/core/src/index.ts";
import {
  FirestoreClient,
  analyze,
  buildInstructionBlock,
  estimate,
  estimateTokens,
  isFirebaseConfigured,
  pushUsageEvent,
  refreshLeaderboardRow,
  adviseOnPrompt,
  classifyModelName,
  lengthOpportunity,
  rewritePrompt,
  stableHash,
  suggestModel,
  syncUsageEvent,
  wasteProfileOf,
  type AuthSession,
  type FirebaseWebConfig,
} from "../../packages/core/src/index.ts";
import { pick, pickAll, readComposer, siteFor, type SiteConfig } from "./sites.ts";

const site: SiteConfig = siteFor(location.hostname);

/**
 * Is this content script still attached to a live extension?
 *
 * Reloading the extension (or updating it) orphans the copy already running in
 * an open tab: the DOM listeners keep firing, but every chrome.* call throws
 * "Extension context invalidated". Unhandled, that is an error on the page
 * for every keystroke the user makes.
 */
function extensionAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

let tornDown = false;

/** Leave the page exactly as we found it, once we can no longer work. */
function teardown(): void {
  if (tornDown) return;
  tornDown = true;
  removeNudge();
  observer?.disconnect();
  document.querySelectorAll(".owo-receipt").forEach((el) => el.remove());
  console.info("[Output-Waste Optimizer] extension reloaded; this tab's copy has stopped. Reload the page to resume.");
}

/** Run a chrome.* call, and shut down cleanly if the context has gone. */
function safely<T>(fn: () => T): T | undefined {
  if (tornDown) return undefined;
  if (!extensionAlive()) {
    teardown();
    return undefined;
  }
  try {
    return fn();
  } catch (error) {
    if (String(error).includes("Extension context invalidated")) {
      teardown();
      return undefined;
    }
    throw error;
  }
}

let observer: MutationObserver | null = null;
let config: Config | null = null;

/**
 * Auto-apply, off by default.
 *
 * Only the OUTPUT DIRECTIONS are ever applied automatically. They append a
 * sentence telling the model to skip preamble and recaps, which is where
 * essentially all of the energy saving lives and which cannot change what the
 * user asked for.
 *
 * Trimming the user's own words is never automatic, however safe it looks.
 * If we silently drop a paragraph we judged redundant and the answer comes back
 * wrong, the user blames the model and never traces it to us. A few saved
 * tokens are not worth being the invisible cause of a bad answer.
 */
let autoDirections = false;

/**
 * Account sync, also off until the user signs in from the popup.
 *
 * On the free Firebase plan there is no server to post to, so this writes the
 * receipt straight to Firestore as the signed-in user. The session lives in
 * chrome.storage, which means the popup can revoke it and every open tab picks
 * that up through the storage listener below.
 */
let session: AuthSession | null = null;
let firebase: FirebaseWebConfig | null = null;
let client: FirestoreClient | null = null;

/**
 * What this user's replies waste tokens on, by type.
 *
 * Counts only, never text, so it is safe to keep. It is what makes the
 * directions specific: someone whose model restates every question gets told
 * to stop doing that, instead of the same generic line as everybody else.
 */
let wasteProfile: WasteProfile = {};

function readSession(value: unknown): AuthSession | null {
  const candidate = value as Partial<AuthSession> | undefined;
  return candidate?.uid && candidate.refreshToken && candidate.idToken
    ? {
        uid: candidate.uid,
        idToken: candidate.idToken,
        refreshToken: candidate.refreshToken,
        expiresAt: candidate.expiresAt ?? 0,
      }
    : null;
}

function loadSettings(): Promise<void> {
  return new Promise((resolve) => {
    safely(() => chrome.storage?.local.get(["autoDirections", "pfSession", "wasteByType"], (s) => {
      autoDirections = s["autoDirections"] === true;
      session = readSession(s["pfSession"]);
      client = null;
      wasteProfile = (s["wasteByType"] as WasteProfile) ?? {};
      resolve();
    })) ?? resolve();
  });
}

/**
 * A client for the current session, built lazily and thrown away whenever the
 * session changes. It writes refreshed tokens back to chrome.storage so a tab
 * left open past the one-hour token lifetime keeps syncing.
 */
function firestore(): FirestoreClient | null {
  if (!session || !firebase) return null;
  client ??= new FirestoreClient(firebase, session, {
    onSession: (next) => {
      session = next;
      safely(() => chrome.storage?.local.set({ pfSession: next }));
    },
  });
  return client;
}

/** Turn auto-apply off and remember it, so the setting survives a reload. */
function disableAutoDirections(): void {
  autoDirections = false;
  safely(() => chrome.storage?.local.set({ autoDirections: false }));
}

// --- setup ------------------------------------------------------------------

async function loadConfig(): Promise<Config> {
  if (!extensionAlive()) throw new Error("Extension context is gone.");
  const [sources, models] = await Promise.all([
    fetch(chrome.runtime.getURL("config/sources.json")).then((r) => r.json()),
    fetch(chrome.runtime.getURL("config/models.json")).then((r) => r.json()),
  ]);
  return { sources, models };
}

/** Absent or unfilled config is normal: sync is optional, analysis is not. */
async function loadFirebaseConfig(): Promise<FirebaseWebConfig | null> {
  try {
    if (!extensionAlive()) return null;
    const candidate = await fetch(chrome.runtime.getURL("config/firebase.json")).then((r) => r.json());
    return isFirebaseConfigured(candidate) ? (candidate as FirebaseWebConfig) : null;
  } catch {
    return null;
  }
}

async function boot(): Promise<void> {
  config = await loadConfig();
  firebase = await loadFirebaseConfig();
  await loadSettings();
  safely(() => chrome.storage?.onChanged?.addListener((changes) => {
    if (changes["autoDirections"]) autoDirections = changes["autoDirections"].newValue === true;
    if (changes["pfSession"]) {
      session = readSession(changes["pfSession"].newValue);
      client = null;
    }
  }));
  installProbe();
  watchComposer();
  watchReplies();
  console.info(
    `[Output-Waste Optimizer] active on "${site.label}". Run window.__owoProbe() to check selectors.`,
  );
}

/**
 * Selector health check, callable from the page console.
 * Site markup changes without warning; this turns "the extension is broken"
 * into "this one selector stopped matching", which is a two-minute fix.
 */
/**
 * Which model the page says is selected.
 *
 * Read-only, and allowed to fail: when the picker is not found or its label is
 * something like "Fast", the suggestion falls back to naming the site's own
 * default. Guessing a model from a label we do not recognise would be worse
 * than saying nothing.
 */
function readCurrentModel(): string | null {
  const { el } = pick<HTMLElement>(document, site.modelIndicator ?? []);
  const text = (el?.innerText ?? el?.getAttribute("aria-label") ?? "").trim();
  return text && text.length <= 40 ? text.split("\n")[0]!.trim() : null;
}

function installProbe(): void {
  (window as unknown as { __owoProbe: () => void }).__owoProbe = () => {
    const report = (name: string, sels: string[]) => {
      const { used } = pick(document, sels);
      console.log(`  ${used ? "OK  " : "MISS"} ${name}: ${used ?? sels.join(" | ")}`);
    };
    console.log(`[OWO] site config: ${site.id} (${site.label})`);
    report("composer", site.composer);
    report("conversationRoot", site.conversationRoot);
    report("assistantMessage", site.assistantMessage);
    report("userMessage", site.userMessage);
    console.log(`  assistant messages found: ${pickAll(document, site.assistantMessage).length}`);
  };
}

// --- 1. pre-send nudge ------------------------------------------------------

let nudgeEl: HTMLDivElement | null = null;
/**
 * The draft as it was before auto-apply touched it.
 *
 * Held across re-renders because the input event we fire re-triggers the
 * debounce, which would otherwise replace the note (and its Undo) ~400ms after
 * it appeared. An undo button that disappears before you can reach it is worse
 * than no undo at all: it tells the user the change is reversible and then
 * takes that back.
 */
let pendingUndo: { original: string } | null = null;
/**
 * Set when the user undoes an auto-add, cleared once the composer empties.
 *
 * Without it the undo undoes itself: writing the original text back fires an
 * input event, the debounce runs again, auto-apply sees a draft with no
 * directions and appends them a second time. From the user's side the Undo
 * button simply does not work.
 *
 * Emptying the composer is the closest thing to "message sent" that works on
 * every site, and it is the right moment to start offering again.
 */
let autoSuppressed = false;
let debounce: number | undefined;
/** The draft we last analysed, so an unchanged one is not analysed twice. */
let lastDraft = "";
/** Short drafts are noise; nobody needs advice on "thanks". */
/**
 * No minimum. An early version waited for 12 words and a typing pause, which
 * meant a short prompt never got a nudge at all and a long one got it late.
 * Analysis is local string work on a draft, so it is cheap enough to run on
 * every change; the only guard is skipping a draft identical to the last one.
 */
const MIN_DRAFT_WORDS = 0;

function watchComposer(): void {
  document.addEventListener(
    "input",
    (e) => {
      const target = e.target as Element | null;
      if (!target || !isComposer(target)) return;
      window.clearTimeout(debounce);
      evaluateDraft(target);
    },
    true,
  );

  // Chrome does not replay input events that happened before the extension was
  // loaded. Evaluate an existing draft immediately so activation on an already
  // open chat produces a nudge without making the user type another character.
  const existing = pick(document, site.composer).el;
  if (existing) evaluateDraft(existing);
}

function isComposer(el: Element): boolean {
  return site.composer.some((sel) => el.matches?.(sel)) || el === pick(document, site.composer).el;
}

function evaluateDraft(composer: Element): void {
  if (!config) return;
  const draft = readComposer(composer).trim();

  if (draft.split(/\s+/).filter(Boolean).length < MIN_DRAFT_WORDS) {
    // The draft is gone or barely started: forget the last one entirely.
    removeNudge();
    pendingUndo = null;
    autoSuppressed = false;
    return;
  }

  const rewrite = rewritePrompt(draft, undefined, { wasteProfile });
  const suggestion = suggestModel(draft, config, site.defaultModelClass);

  // Auto-apply the safe half: append the output directions if they are not
  // already there. Done visibly, in the composer, so the user can see and
  // delete it. Silent modification is what makes auto-apply untrustworthy.
  //
  // rewrite.added is empty when the directions are already in the draft, so
  // this cannot append them twice.
  if (autoDirections && !autoSuppressed && rewrite.added.length > 0) {
    const withDirections = `${draft} ${rewrite.added.join(" ")}`.trim();
    pendingUndo = { original: draft };
    setComposerText(composer, withDirections);
    showAutoNote(composer, rewrite.added.join(" "), draft);
    return;
  }

  // The directions are gone again (the user deleted them): the stored undo
  // point no longer describes anything, so drop it.
  if (rewrite.added.length > 0) pendingUndo = null;

  // Offer the button only when pressing it would actually change the draft.
  // Offering a rewrite identical to what is already typed is how the old
  // version invited the same click over and over.
  const canRewrite = normalizeWs(rewrite.rewritten) !== normalizeWs(draft);

  // Only interrupt when there is something worth saying.
  if (!canRewrite && !suggestion.isDowngrade) {
    removeNudge();
    return;
  }

  const advice = adviseOnPrompt(draft);
  const detected = readCurrentModel();
  showNudge(composer, {
    canRewrite,
    detectedModel: detected,
    advice: advice[0] ? `${advice[0].why} ${advice[0].suggestion}` : "",
    tokenDelta: rewrite.tokenDelta,
    removedCount: rewrite.removed.length,
    added: rewrite.added,
    rewritten: rewrite.rewritten,
    suggestion,
  });
}

interface NudgeData {
  canRewrite: boolean;
  /** The model name shown on the page, when it could be read. */
  detectedModel: string | null;
  /** The single most useful thing to change about the request itself. */
  advice: string;
  tokenDelta: number;
  removedCount: number;
  added: string[];
  rewritten: string;
  suggestion: ReturnType<typeof suggestModel>;
}

/**
 * Build an element without innerHTML.
 *
 * Google properties send `require-trusted-types-for 'script'`, and assigning
 * innerHTML under that policy throws. That is why the whole overlay failed on
 * Gemini while every selector was correct. Building nodes also means no
 * escaping step to get wrong.
 */
function node(
  tag: string,
  className: string,
  text?: string,
  attrs: Record<string, string> = {},
): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

/** What the bar currently says, so an unchanged bar is left alone. */
let nudgeSignature = "";

function showNudge(composer: Element, data: NudgeData): void {
  // Without the typing pause this runs on every keystroke. Rebuilding the bar
  // each time makes it flicker and jump under the cursor, so a bar that would
  // say exactly the same thing is left where it is.
  const signature = JSON.stringify([
    data.canRewrite,
    data.advice,
    data.rewritten,
    data.detectedModel,
    data.suggestion.suggestedTier,
    data.suggestion.isDowngrade,
    pendingUndo !== null,
  ]);
  if (nudgeEl && signature === nudgeSignature) return;
  nudgeSignature = signature;
  removeNudge();
  const box = document.createElement("div");
  box.className = "owo-nudge";

  const bits: HTMLElement[] = [];
  if (data.canRewrite) {
    // Say what the button will do. "Trim" on a prompt that only gains output
    // directions would be a lie, and the token count has to match the direction
    // of travel or the next click feels broken.
    const action =
      data.removedCount === 0
        ? "Add output limits"
        : data.tokenDelta < 0
          ? `Trim prompt (${Math.abs(data.tokenDelta)} tokens shorter)`
          : "Tidy prompt";
    // The tooltip names the exact directions, so the button is not a black box
    // and the user can see they change with the prompt.
    const willAdd = data.added.length > 0 ? `Adds: ${data.added.join(" ")}` : "Trims your prompt only.";
    bits.push(node("button", "owo-btn", action, { "data-owo-apply": "1", title: willAdd }));
  }
  if (data.advice) {
    // One line only. The composer bar is not a report, and a nudge that fills
    // the screen is a nudge people turn off.
    const short = data.advice.length > 90 ? `${data.advice.slice(0, 88)}…` : data.advice;
    bits.push(node("span", "owo-pill", short, { title: data.advice }));
  }
  if (data.suggestion.isDowngrade) {
    // Recommend for the site in front of the user, not a generic tier.
    const mine =
      data.suggestion.recommendations.find((r) => r.platformId === site.id) ??
      data.suggestion.recommendations.find((r) => r.platformId === "claude");
    const current =
      data.detectedModel && config ? classifyModelName(data.detectedModel, config) : null;
    const order = ["small", "medium", "large"];
    // Already on something at or below what we would suggest: saying "switch"
    // to the model they are using is the fastest way to lose their trust.
    const worthSaying =
      !current || order.indexOf(current.tier) > order.indexOf(data.suggestion.suggestedTier);
    if (mine && worthSaying) {
      const prefix = data.detectedModel ? `On ${data.detectedModel}: ` : "";
      bits.push(
        node("span", "owo-pill", `${prefix}${mine.model} at ${mine.effort} effort is likely enough`, {
          title: data.suggestion.caveats.join(" "),
        }),
      );
    }
  }

  box.appendChild(node("span", "owo-tag", "before you send"));
  for (const bit of bits) box.appendChild(bit);
  if (pendingUndo) {
    box.appendChild(
      node("button", "owo-btn owo-ghost", "Undo auto-add", {
        "data-owo-undo": "1",
        title: "Puts your draft back and turns auto-add off.",
      }),
    );
  }
  box.appendChild(node("button", "owo-x", "\u00d7", { "data-owo-dismiss": "1", title: "Dismiss" }));

  box.querySelector("[data-owo-undo]")?.addEventListener("click", (e) => {
    e.preventDefault();
    const original = pendingUndo?.original;
    pendingUndo = null;
    undoAutoApply();
    if (original !== undefined) setComposerText(composer, original);
    removeNudge();
  });

  box.querySelector("[data-owo-apply]")?.addEventListener("click", (e) => {
    e.preventDefault();
    // The click IS the approval. Nothing is rewritten without it.
    setComposerText(composer, data.rewritten);
    removeNudge();
  });
  box.querySelector("[data-owo-dismiss]")?.addEventListener("click", removeNudge);

  position(box, composer);
  document.body.appendChild(box);
  nudgeEl = box;
}

/**
 * What Undo means: put the draft back, and stop adding it.
 *
 * Restoring the text fires an input event, which restarts the debounce, which
 * would auto-apply again a moment later — so an undo that only restores text
 * visibly undoes itself. Suppressing it in memory fixes that for this draft;
 * turning the setting off is what stops the loop coming back on the next one,
 * and survives the content script being re-injected on an SPA navigation.
 *
 * Undoing an automatic edit is a clear "do not do that", so the setting goes
 * off and the user gets the button instead. The popup toggle turns it back on.
 */
function undoAutoApply(): void {
  autoSuppressed = true;
  disableAutoDirections();
}

/** Says what was added and offers one-click undo. Visible beats silent. */
function showAutoNote(composer: Element, added: string, original: string): void {
  removeNudge();
  const box = document.createElement("div");
  box.className = "owo-nudge";
  box.appendChild(node("span", "owo-tag", "added automatically"));
  box.appendChild(node("span", "owo-pill", added));
  box.appendChild(
    node("button", "owo-btn", "Undo & stop", {
      "data-owo-undo": "1",
      title: "Puts your draft back and turns auto-add off.",
    }),
  );
  box.appendChild(node("button", "owo-x", "\u00d7", { "data-owo-dismiss": "1", title: "Dismiss" }));
  box.querySelector("[data-owo-undo]")?.addEventListener("click", (e) => {
    e.preventDefault();
    pendingUndo = null;
    undoAutoApply();
    setComposerText(composer, original);
    removeNudge();
  });
  box.querySelector("[data-owo-dismiss]")?.addEventListener("click", removeNudge);
  position(box, composer);
  document.body.appendChild(box);
  nudgeEl = box;
}

function position(box: HTMLElement, anchor: Element): void {
  const r = anchor.getBoundingClientRect();
  const margin = 12;
  box.style.position = "fixed";
  box.style.left = `${Math.max(margin, r.left)}px`;
  box.style.top = `${Math.max(margin, r.top - 46)}px`;
  box.style.maxWidth = `${Math.min(Math.max(280, r.width), window.innerWidth - margin * 2)}px`;

  // Place it only once its real size is known. Covering the box someone is
  // typing into is worse than not showing the hint at all.
  requestAnimationFrame(() => {
    const self = box.getBoundingClientRect();
    if (self.right > window.innerWidth - margin) {
      box.style.left = `${Math.max(margin, window.innerWidth - self.width - margin)}px`;
    }
    const gap = 8;
    const roomAbove = r.top - margin;
    const roomBelow = window.innerHeight - r.bottom - margin;
    if (self.height + gap <= roomAbove) {
      box.style.top = `${r.top - self.height - gap}px`;
    } else if (self.height + gap <= roomBelow) {
      // Gemini keeps its composer near the bottom with little room above it.
      box.style.top = `${r.bottom + gap}px`;
    } else {
      // Nowhere clear: sit above the composer's top edge and let it scroll
      // rather than overlap the text being typed.
      box.style.top = `${Math.max(margin, r.top - self.height - gap)}px`;
    }
  });
}

function removeNudge(): void {
  nudgeEl?.remove();
  nudgeEl = null;
  nudgeSignature = "";
}

/**
 * Write into the composer in a way React notices.
 * Setting .value directly is invisible to React's synthetic events, so the send
 * button stays disabled and the user thinks the extension is broken.
 */
function setComposerText(el: Element, text: string): void {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  const node = el as HTMLElement;
  node.focus();

  // execCommand is deprecated but is still the most reliable way to edit a
  // rich-text editor so its framework registers the change.
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.execCommand("insertText", false, text);

  // Verify rather than trust the return value. execCommand can report success
  // and do nothing, and because we selected the whole box first, that leaves it
  // EMPTY - deleting the prompt the user was writing. Never ship a "helpful"
  // button that can eat someone's work.
  if (normalizeWs(node.innerText ?? "") !== normalizeWs(text)) {
    node.innerText = text;
  }

  node.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// --- 2. reply receipt -------------------------------------------------------

const seen = new WeakSet<Element>();

/**
 * Hashes of replies already counted, so a re-render cannot count one twice.
 *
 * `seen` keys on the element, which is not enough: these apps rebuild the
 * conversation from scratch when you switch chats and come back, producing new
 * elements holding the same text. Without this the totals climb on their own,
 * and a footprint tool whose numbers inflate when you navigate is worse than
 * no tool. Hashes, not text, so nothing readable is held in memory.
 */
const countedText = new Set<string>();

function watchReplies(): void {
  // Observe document.body, not the conversation root.
  //
  // These sites are single-page apps: sending the first message navigates from
  // the new-chat view to /c/<id>, and the framework swaps out the <main>
  // element on the way. An observer bound to the root found at boot is then
  // watching a node that is no longer in the page, so no reply ever arrives and
  // the extension looks dead while every selector it uses is perfectly correct.
  //
  // body is the one node the app never replaces. The extra mutations it sees
  // cost nothing here, because the work is debounced and scanReplies only acts
  // on messages it has not already measured.
  observer = new MutationObserver(() => {
    window.clearTimeout(replyDebounce);
    // Replies stream in token by token. Waiting for a quiet moment means we
    // measure the finished answer instead of a half-written one.
    replyDebounce = window.setTimeout(scanReplies, 700);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  scanReplies();
}

let replyDebounce: number | undefined;

function scanReplies(): void {
  if (!config) return;
  const messages = pickAll<HTMLElement>(document, site.assistantMessage);
  const prompts = pickAll<HTMLElement>(document, site.userMessage);

  for (const msg of messages) {
    if (seen.has(msg)) continue;
    const text = msg.innerText?.trim() ?? "";
    if (text.length < 40) continue;
    if (isProviderError(text)) continue;
    seen.add(msg);

    // Same reply, new element: a re-render, not a new answer. The receipt is
    // drawn again so it does not vanish when you switch chats and come back,
    // but nothing is added to the totals.
    const fingerprint = stableHash(text);
    const alreadyCounted = countedText.has(fingerprint);
    countedText.add(fingerprint);

    attachReceipt(msg, text, promptBefore(msg, prompts), alreadyCounted);

    // A reply means the draft was sent. Clear the pre-send bar, which is
    // pinned over the composer and otherwise sits on top of the new receipt,
    // and start offering again on the next draft.
    removeNudge();
    pendingUndo = null;
    autoSuppressed = false;
  }
}

/** Provider error banners are not model output and must not consume the user's totals. */
function isProviderError(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    "something went wrong",
    "please try again later",
    "there was an error generating",
    "network error",
    "response was blocked",
  ].some((message) => normalized.includes(message));
}

/** Pair each answer with the nearest user message before it in document order. */
function promptBefore(message: Element, prompts: HTMLElement[]): string {
  let nearest = "";
  for (const prompt of prompts) {
    const relation = prompt.compareDocumentPosition(message);
    if ((relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
      nearest = prompt.innerText ?? "";
    }
  }
  return nearest;
}

function attachReceipt(
  msg: HTMLElement,
  response: string,
  prompt: string,
  alreadyCounted = false,
): void {
  if (!config) return;

  const result = analyze(response, prompt);
  const modelClass: ModelClass = site.defaultModelClass;
  const est = estimate(
    {
      id: "live",
      timestamp: new Date().toISOString(),
      surface: "web",
      tool: site.id,
      model: modelClass,
      model_class: modelClass,
      tokens: {
        input: 0,
        cache_write: 0,
        cache_read: 0,
        output: result.totalOutputTokens,
        reasoning: 0,
      },
      token_source: "estimated",
      flags: result.flags,
      region: "PJM",
    },
    config,
    { wastedOutputTokens: result.wastedOutputTokens },
  );

  const scored = result.flags.filter((f) => f.confidence === "high");
  const pct = Math.round(result.efficiency * 100);
  const bar = document.createElement("div");
  bar.className = `owo-receipt ${
    scored.length === 0 && result.coverage.lengthTargetWords === null
      ? "owo-mid"
      : pct >= 90
        ? "owo-good"
        : pct >= 70
          ? "owo-mid"
          : "owo-bad"
  }`;
  // A bare "100% efficient" on a reply where nothing could be measured reads
  // as "this answer was perfect". Say what was actually checked instead.
  const opportunity = lengthOpportunity(prompt, response);
  const measuredNothing = scored.length === 0 && result.coverage.lengthTargetWords === null;

  bar.appendChild(node("span", "owo-score", measuredNothing ? "\u2014" : `${pct}%`));
  bar.appendChild(
    node("span", "owo-score-label", measuredNothing ? "no waste patterns found" : "efficient"),
  );
  bar.appendChild(node("span", "owo-sep"));
  bar.appendChild(node("span", "owo-stat", `${result.wastedOutputTokens} wasted tokens`));
  bar.appendChild(
    node("span", "owo-stat", fmt(est.wasted.energyWh.low, est.wasted.energyWh.high, "Wh")),
  );
  if (scored.length > 0) {
    bar.appendChild(
      node("button", "owo-link", `${scored.length} findings`, { "data-owo-detail": "1" }),
    );
  }
  if (opportunity) {
    bar.appendChild(
      node(
        "span",
        "owo-stat",
        `${opportunity.replyWords} words \u00b7 asking "${opportunity.ask}" would have cut about ${opportunity.excessWords}`,
        { title: "Not counted as waste: you did not ask for a shorter answer. It is what a limit would have saved." },
      ),
    );
  } else if (measuredNothing) {
    bar.appendChild(
      node("span", "owo-stat", "length not checked", {
        title: result.coverage.note,
      }),
    );
  }
  bar.appendChild(node("span", "owo-note", "estimated locally"));

  if (scored.length > 0) {
    const detail = node("div", "owo-detail");
    detail.hidden = true;
    const list = document.createElement("ul");
    for (const flag of scored) {
      const item = document.createElement("li");
      item.appendChild(node("b", "", label(flag)));
      item.appendChild(document.createTextNode(` \u2014 ${flag.why}`));
      list.appendChild(item);
    }
    detail.appendChild(list);
    const fix = node("div", "owo-fix");
    fix.appendChild(node("b", "", "Stop this happening again:"));
    fix.appendChild(node("code", "", buildInstructionBlock(result.flags).block));
    detail.appendChild(fix);
    bar.querySelector("[data-owo-detail]")?.addEventListener("click", () => {
      detail.hidden = !detail.hidden;
    });
    bar.appendChild(detail);
  }

  msg.appendChild(bar);

  // A redraw of a reply already measured: the receipt above is shown again,
  // but counting it a second time would be a lie.
  if (alreadyCounted) return;

  // Learn from this reply straight away, so the next draft's directions already
  // target whatever this one wasted tokens on.
  const seenNow = wasteProfileOf(result.flags);
  for (const [type, tokens] of Object.entries(seenNow)) {
    const key = type as Flag["type"];
    wasteProfile[key] = (wasteProfile[key] ?? 0) + (tokens ?? 0);
  }

  bumpTotals(result.wastedOutputTokens, result.totalOutputTokens, est);
  void syncReceipt(prompt, result, est, modelClass);
}

async function syncReceipt(
  prompt: string,
  result: ReturnType<typeof analyze>,
  est: Estimate,
  modelClass: ModelClass,
): Promise<void> {
  const target = firestore();
  if (!target) return;
  const event = syncUsageEvent({
    surface: "web",
    tool: site.id,
    modelClass,
    tokens: {
      input: estimateTokens(prompt).tokens,
      output: result.totalOutputTokens,
      reasoning: 0,
      cache_read: 0,
      cache_write: 0,
    },
    totalOutputTokens: result.totalOutputTokens,
    wastedOutputTokens: result.wastedOutputTokens,
    efficiency: result.efficiency,
    flags: result.flags,
    estimate: est,
  });
  try {
    await pushUsageEvent(target, event);
    // Keep the public board current from this surface too, not only the dashboard.
    await refreshLeaderboardRow(target);
  } catch (error) {
    console.warn("[PromptFootprint] Account sync failed; local tracking still succeeded.", error);
  }
}

const LABELS: Record<Flag["type"], string> = {
  echo: "Restated your question",
  filler: "Pleasantry",
  repetition: "Repetition",
  recap: "Redundant recap",
  boilerplate: "Boilerplate",
  overlength: "Over-long",
  prompt_side: "In your prompt",
};
const label = (f: Flag): string => LABELS[f.type];

interface StoredResourceTotals {
  energyWh: Range;
  waterMl: Range;
  co2g: Range;
}

function addRange(a: Range | undefined, b: Range): Range {
  return {
    low: (a?.low ?? 0) + b.low,
    high: (a?.high ?? 0) + b.high,
    unit: b.unit,
  };
}

function addResources(
  previous: StoredResourceTotals | undefined,
  next: Pick<Estimate, "energyWh" | "waterMl" | "co2g">,
): StoredResourceTotals {
  return {
    energyWh: addRange(previous?.energyWh, next.energyWh),
    waterMl: addRange(previous?.waterMl, next.waterMl),
    co2g: addRange(previous?.co2g, next.co2g),
  };
}

/** Aggregate counts and resource ranges only. Prompt and response text never enter storage. */
function bumpTotals(wasted: number, total: number, estimateForReply: Estimate): void {
  safely(() => chrome.storage?.local.get(
    ["wasted", "total", "replies", "resourcesTotal", "resourcesWasted"],
    (prev) => {
    chrome.storage.local.set({
      wasted: (prev["wasted"] ?? 0) + wasted,
      total: (prev["total"] ?? 0) + total,
      replies: (prev["replies"] ?? 0) + 1,
      // Counts per waste type, never text. This is what the directions read.
      wasteByType: wasteProfile,
      resourcesTotal: addResources(prev["resourcesTotal"] as StoredResourceTotals | undefined, estimateForReply),
      resourcesWasted: addResources(
        prev["resourcesWasted"] as StoredResourceTotals | undefined,
        estimateForReply.wasted,
      ),
    });
    },
  ));
}

// --- helpers ----------------------------------------------------------------

function fmt(low: number, high: number, unit: string): string {
  const scale = Math.max(low, high) < 1 ? 1000 : 1;
  const u = scale === 1000 ? `m${unit}` : unit;
  const s = (n: number) => String(Number((n * scale).toPrecision(2)));
  return low === high ? `${s(low)} ${u}` : `${s(low)}–${s(high)} ${u}`;
}


void boot();
