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

const CHATGPT: SiteConfig = {
  id: "chatgpt",
  label: "ChatGPT",
  hosts: ["chatgpt.com", "chat.openai.com"],
  composer: [
    "#prompt-textarea",
    "div[contenteditable='true'][data-virtualkeyboard]",
    "form div[contenteditable='true']",
    "form textarea",
  ],
  conversationRoot: ["main", "div[role='presentation']"],
  assistantMessage: [
    "[data-message-author-role='assistant']",
    "div[data-testid^='conversation-turn'] .markdown",
  ],
  userMessage: ["[data-message-author-role='user']"],
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

const SITES: SiteConfig[] = [CHATGPT, CLAUDE, MOCK];

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
    if (found.length > 0) return found;
  }
  return [];
}

/** Read text from a textarea or a contenteditable, whichever this is. */
export function readComposer(el: Element): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
  return (el as HTMLElement).innerText ?? "";
}

export const ALL_SITES = SITES;
export { GENERIC };
