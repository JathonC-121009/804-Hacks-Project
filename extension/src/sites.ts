/**
 * Per-site DOM configuration.
 *
 * This file is the fragile part of the whole product and it is isolated here on
 * purpose. Chat sites rewrite their markup without warning, so when the
 * extension breaks the fix is one selector in this file, not a hunt through
 * the logic.
 *
 * Three defences against that fragility:
 *   1. every selector is a LIST, tried in order, so a redesign has to break all
 *      of them before the extension dies;
 *   2. a generic fallback that keys off roles and shapes rather than class
 *      names, which keeps working on sites we have never seen;
 *   3. the mock page in extension/mock/, so the demo has a path that no
 *      third-party redesign can take away.
 *
 * [VERIFY] The chatgpt.com and claude.ai selectors below were written from the
 * general shape of those apps and have NOT been checked against the live DOM.
 * Open each site, run `window.__owoProbe()` from the console (the content
 * script installs it) and fix whatever reports "no match" before the demo.
 */

export interface SiteConfig {
  id: string;
  label: string;
  /** Matched against location.hostname. */
  hosts: string[];
  /** Where the user types. First match wins. */
  composer: string[];
  /** The element whose subtree gains new assistant messages. */
  conversationRoot: string[];
  /** A single assistant message inside that root. */
  assistantMessage: string[];
  /** Optional: the user's own message, used to pair a reply with its prompt. */
  userMessage: string[];
  /** Model-class guess for this site when the user has not set one. */
  defaultModelClass: "small" | "medium" | "large";
}

/**
 * Probed against the live site on 18 Oct 2026. What changed since the first
 * version, all of it confirmed by running the probe in a real conversation:
 *
 *   - `#prompt-textarea` no longer exists. The composer is now a contenteditable
 *     carrying `data-virtualkeyboard`.
 *   - Every message-level data attribute is gone: no `data-message-author-role`,
 *     no `data-message-id`, no `data-testid` on turns, no `.markdown`.
 *   - Assistant content is now a `prose` class; user content is marked with
 *     `user-message` and the text itself is `.text-size-chat.whitespace-pre-wrap`.
 *   - `data-talvt-turn-state` wraps a whole exchange rather than one message, so
 *     it cannot separate the two speakers and is not used here.
 *
 * The old selectors are kept below the new ones rather than deleted: they cost
 * nothing when they miss, and they make the adapter work on whichever build a
 * given machine is served. `block-BQZwFn`-style hashed classes are deliberately
 * not used; they change on every deploy.
 */
const CHATGPT: SiteConfig = {
  id: "chatgpt",
  label: "ChatGPT",
  hosts: ["chatgpt.com", "chat.openai.com"],
  composer: [
    "div[contenteditable='true'][data-virtualkeyboard]",
    "#prompt-textarea",
    "form div[contenteditable='true']",
    "div[contenteditable='true']",
    "form textarea",
  ],
  conversationRoot: ["main", "div[role='presentation']"],
  assistantMessage: [
    "[data-message-author-role='assistant']",
    "[class*='markdown']",
    "[class*='prose']",
    "div[data-testid^='conversation-turn'] .markdown",
  ],
  userMessage: [
    "[data-message-author-role='user']",
    "[class*='user-message']",
    ".text-size-chat.whitespace-pre-wrap",
  ],
  defaultModelClass: "large",
};

const CLAUDE: SiteConfig = {
  id: "claude",
  label: "Claude",
  hosts: ["claude.ai"],
  composer: [
    "div[contenteditable='true'].ProseMirror",
    "div[contenteditable='true']",
    "fieldset textarea",
  ],
  conversationRoot: ["main", "div[data-testid='chat-messages']"],
  assistantMessage: [
    "[data-testid='assistant-message']",
    "div.font-claude-message",
    "div[data-is-streaming='false']",
  ],
  userMessage: ["[data-testid='user-message']", "div.font-user-message"],
  defaultModelClass: "large",
};

const GEMINI: SiteConfig = {
  id: "gemini",
  label: "Google Gemini",
  hosts: ["gemini.google.com"],
  composer: [
    "rich-textarea div[contenteditable='true']",
    ".ql-editor[contenteditable='true']",
    "div[contenteditable='true'][role='textbox']",
    "textarea",
  ],
  conversationRoot: ["main", "chat-window", "body"],
  assistantMessage: [
    "model-response .markdown",
    "model-response message-content",
    "model-response",
    "[data-test-id='model-response']",
  ],
  userMessage: ["user-query", ".user-query", "[data-test-id='user-query']"],
  defaultModelClass: "large",
};

const PERPLEXITY: SiteConfig = {
  id: "perplexity",
  label: "Perplexity",
  hosts: ["perplexity.ai"],
  composer: [
    "textarea[placeholder]",
    "div[contenteditable='true'][role='textbox']",
    "div[contenteditable='true']",
  ],
  conversationRoot: ["main", "[role='main']", "body"],
  assistantMessage: [
    "[data-testid='answer']",
    "[data-testid='copilot-answer']",
    "[data-message-author-role='assistant']",
    ".prose",
  ],
  userMessage: ["[data-testid='query']", "[data-message-author-role='user']"],
  defaultModelClass: "large",
};

const COPILOT: SiteConfig = {
  id: "copilot",
  label: "Microsoft Copilot",
  hosts: ["copilot.microsoft.com"],
  composer: [
    "textarea",
    "div[contenteditable='true'][role='textbox']",
    "cib-text-input textarea",
  ],
  conversationRoot: ["main", "cib-serp", "body"],
  assistantMessage: [
    "[data-content='ai-message']",
    "[data-testid='ai-message']",
    "[data-message-author-role='assistant']",
    "cib-message-group[source='bot'] cib-message",
  ],
  userMessage: [
    "[data-content='user-message']",
    "[data-testid='user-message']",
    "[data-message-author-role='user']",
    "cib-message-group[source='user'] cib-message",
  ],
  defaultModelClass: "large",
};

const GROK: SiteConfig = {
  id: "grok",
  label: "Grok",
  hosts: ["grok.com", "x.com"],
  composer: [
    "textarea",
    "div[contenteditable='true'][role='textbox']",
    "div[contenteditable='true']",
  ],
  conversationRoot: ["main", "[role='main']", "body"],
  assistantMessage: [
    "[data-message-author-role='assistant']",
    "[data-testid='assistant-message']",
    "[data-testid='message-bubble'][data-author='assistant']",
  ],
  userMessage: [
    "[data-message-author-role='user']",
    "[data-testid='user-message']",
    "[data-testid='message-bubble'][data-author='user']",
  ],
  defaultModelClass: "large",
};

const POE: SiteConfig = {
  id: "poe",
  label: "Poe",
  hosts: ["poe.com"],
  composer: ["textarea", "div[contenteditable='true'][role='textbox']"],
  conversationRoot: ["main", "[class*='ChatMessagesView']", "body"],
  assistantMessage: [
    "[data-message-author-role='assistant']",
    "[class*='Message_botMessage']",
    "[class*='BotMessage']",
  ],
  userMessage: ["[data-message-author-role='user']", "[class*='Message_humanMessage']"],
  defaultModelClass: "large",
};

const DEEPSEEK: SiteConfig = {
  id: "deepseek",
  label: "DeepSeek",
  hosts: ["chat.deepseek.com"],
  composer: ["textarea", "div[contenteditable='true'][role='textbox']"],
  conversationRoot: ["main", "#root", "body"],
  assistantMessage: [
    "[data-message-author-role='assistant']",
    "[data-testid='assistant-message']",
    ".ds-markdown",
  ],
  userMessage: ["[data-message-author-role='user']", "[data-testid='user-message']"],
  defaultModelClass: "large",
};

const MISTRAL: SiteConfig = {
  id: "mistral",
  label: "Mistral Le Chat",
  hosts: ["chat.mistral.ai"],
  composer: ["textarea", "div[contenteditable='true'][role='textbox']"],
  conversationRoot: ["main", "body"],
  assistantMessage: [
    "[data-message-author-role='assistant']",
    "[data-testid='assistant-message']",
    "article .prose",
  ],
  userMessage: ["[data-message-author-role='user']", "[data-testid='user-message']"],
  defaultModelClass: "large",
};

const META_AI: SiteConfig = {
  id: "meta-ai",
  label: "Meta AI",
  hosts: ["meta.ai"],
  composer: ["textarea", "div[contenteditable='true'][role='textbox']"],
  conversationRoot: ["main", "[role='main']", "body"],
  assistantMessage: [
    "[data-message-author-role='assistant']",
    "[data-testid='assistant-message']",
    "[role='article'][data-author='assistant']",
  ],
  userMessage: ["[data-message-author-role='user']", "[data-testid='user-message']"],
  defaultModelClass: "large",
};

const YOU_COM: SiteConfig = {
  id: "you-com",
  label: "You.com",
  hosts: ["you.com"],
  composer: ["textarea", "div[contenteditable='true'][role='textbox']"],
  conversationRoot: ["main", "[role='main']", "body"],
  assistantMessage: [
    "[data-message-author-role='assistant']",
    "[data-testid='assistant-message']",
    "[data-testid='youchat-answer']",
  ],
  userMessage: ["[data-message-author-role='user']", "[data-testid='user-message']"],
  defaultModelClass: "large",
};

/** The local mock page, so the demo never depends on a third party. */
const MOCK: SiteConfig = {
  id: "mock",
  label: "Mock chat (local)",
  hosts: ["localhost", "127.0.0.1"],
  composer: ["#mock-composer"],
  conversationRoot: ["#mock-thread"],
  assistantMessage: [".mock-msg.assistant .mock-body"],
  userMessage: [".mock-msg.user .mock-body"],
  defaultModelClass: "large",
};

/**
 * Last resort for a site with no entry above.
 *
 * Deliberately shape-based rather than name-based: a big editable box is a
 * composer almost everywhere, whatever it is called this month.
 */
const GENERIC: SiteConfig = {
  id: "generic",
  label: "Unknown site (generic rules)",
  hosts: [],
  composer: ["div[contenteditable='true']", "textarea"],
  conversationRoot: ["main", "body"],
  assistantMessage: [
    "[data-message-author-role='assistant']",
    "[class*='assistant']",
    "[class*='message']:not([class*='user'])",
  ],
  userMessage: ["[data-message-author-role='user']", "[class*='user-message']"],
  defaultModelClass: "large",
};

const SITES: SiteConfig[] = [
  CHATGPT,
  CLAUDE,
  GEMINI,
  PERPLEXITY,
  COPILOT,
  GROK,
  POE,
  DEEPSEEK,
  MISTRAL,
  META_AI,
  YOU_COM,
  MOCK,
];

export function siteFor(hostname: string): SiteConfig {
  const host = hostname.toLowerCase();
  for (const site of SITES) {
    if (site.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return site;
  }
  return GENERIC;
}

/** First selector in the list that matches. Returns the selector too, for the probe. */
export function pick<T extends Element>(
  root: ParentNode,
  selectors: string[],
): { el: T | null; used: string | null } {
  for (const sel of selectors) {
    const el = root.querySelector<T>(sel);
    if (el) return { el, used: sel };
  }
  return { el: null, used: null };
}

export function pickAll<T extends Element>(root: ParentNode, selectors: string[]): T[] {
  for (const sel of selectors) {
    const found = Array.from(root.querySelectorAll<T>(sel));
    if (found.length > 0) return innermost(found);
  }
  return [];
}

/**
 * Drop any match that contains another match.
 *
 * The selectors that still work on current chat sites are class-substring
 * matches like `[class*='prose']`, and those happily match a wrapper as well as
 * the message inside it. Without this, one receipt gets pinned to an element
 * wrapping the whole conversation and every reply after it is skipped as
 * already seen. Keeping only the innermost matches makes a selector that is
 * too broad degrade into one that is merely imprecise.
 */
export function innermost<T extends Element>(els: T[]): T[] {
  if (els.length < 2) return els;
  return els.filter((el) => !els.some((other) => other !== el && el.contains(other)));
}

/** Read text from a textarea or a contenteditable, whichever this is. */
export function readComposer(el: Element): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
  return (el as HTMLElement).innerText ?? "";
}

export const ALL_SITES = SITES;
export { GENERIC };
