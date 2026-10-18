/**
 * Selector probe. Paste into the browser console on a chat site.
 *
 * Why this exists: extension/src/sites.ts needs CSS selectors for each chat
 * site's composer and message elements, and those can only be learned from the
 * live DOM of a logged-in session. This finds the likely candidates and prints
 * selectors built only from attributes that tend to survive a redeploy.
 *
 * It reads the page and prints to the console. It types nothing, clicks
 * nothing, sends nothing, and touches no account state.
 *
 * Usage: open ChatGPT or Claude with a conversation on screen, open the
 * console (Option-Cmd-J), paste this whole file, press Enter, copy the output.
 */
(() => {
  /** Attributes that tend to survive a redeploy, worst to best. */
  const looksGenerated = (s) =>
    /^[0-9a-f]{8,}$/i.test(s) || /^[0-9a-f-]{16,}$/i.test(s) || /^(css|sc|emotion)-/.test(s);

  function stableSelector(el) {
    const parts = [];

    if (el.id && !looksGenerated(el.id)) parts.push(`#${el.id}`);

    for (const { name, value } of el.attributes) {
      if (!name.startsWith("data-")) continue;
      if (!value || value.length > 40 || looksGenerated(value)) {
        parts.push(`[${name}]`);
      } else {
        parts.push(`[${name}="${value}"]`);
      }
    }

    const role = el.getAttribute("role");
    if (role) parts.push(`[role="${role}"]`);

    const aria = el.getAttribute("aria-label");
    if (aria && aria.length < 40) parts.push(`[aria-label="${aria}"]`);

    const ph = el.getAttribute("placeholder") || el.getAttribute("data-placeholder");
    if (ph && ph.length < 40) parts.push(`[placeholder="${ph}"]`);

    // Class names last: the least stable thing on a modern site.
    const classes = [...el.classList]
      .filter((c) => c.length > 3 && !looksGenerated(c) && !c.includes("[") && !/^\d/.test(c))
      .slice(0, 2);
    if (classes.length) parts.push(`.${classes.join(".")}`);

    return parts.length ? parts : [el.tagName.toLowerCase()];
  }

  const area = (el) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };
  const visible = (el) => el.offsetParent !== null && area(el) > 500;

  const line = (s) => console.log(s);

  line("");
  line("==================== OWO SELECTOR PROBE ====================");
  line(`HOST: ${location.hostname}`);

  // --- composer: the biggest visible editable thing near the bottom ---------
  const editables = [...document.querySelectorAll("div[contenteditable='true'], textarea")]
    .filter(visible)
    .sort((a, b) => area(b) - area(a));

  line("");
  line(`--- COMPOSER candidates (${editables.length} found, largest first) ---`);
  if (editables.length === 0) line("  none. Is a conversation open with the input box on screen?");
  editables.slice(0, 3).forEach((el, i) => {
    const r = el.getBoundingClientRect();
    line(`  [${i}] <${el.tagName.toLowerCase()}> ${Math.round(r.width)}x${Math.round(r.height)} at y=${Math.round(r.top)}`);
    stableSelector(el).forEach((s) => line(`        ${s}`));
  });

  // --- messages: find the thread by SHAPE, not by class name ---------------
  //
  // Keying off class names containing "message" is how this probe returns
  // nothing on a site that calls them turns, bubbles or rows. Instead: find
  // the element with the most direct children that each hold real text. That
  // is the thread, whatever it is named, and its children are the messages.
  const substantial = (el) => (el.innerText || "").trim().length > 60;

  // Counting children with text is not enough: a page wrapper holding a
  // banner, a paragraph and the thread scores the same as the thread itself.
  // Messages are siblings that RESEMBLE each other, so score on that.
  const depthOf = (el) => {
    let d = 0;
    for (let n = el; n; n = n.parentElement) d++;
    return d;
  };

  let thread = null;
  let best = 0;
  let bestKids = [];

  for (const el of document.querySelectorAll("div, main, section, ol, ul, article")) {
    if (!visible(el)) continue;
    const kids = [...el.children].filter((c) => visible(c) && substantial(c));
    if (kids.length < 2) continue;

    // Classes that appear on at least two of the children. Siblings sharing a
    // class is the strongest cheap signal that they are the same KIND of thing.
    const freq = new Map();
    for (const k of kids) for (const c of k.classList) freq.set(c, (freq.get(c) || 0) + 1);
    const shared = [...freq.entries()].filter(([, n]) => n >= 2).map(([c]) => c);

    const sameTag = new Set(kids.map((k) => k.tagName)).size === 1;

    // Shared classes dominate; a deeper match breaks ties toward the inner
    // container, which is the thread rather than the page wrapper.
    const score =
      kids.length + (shared.length ? 20 : 0) + (sameTag ? 5 : 0) + depthOf(el) * 0.01;

    if (score > best) {
      best = score;
      thread = el;
      bestKids = kids;
    }
  }

  line("");
  line("--- THREAD ROOT (conversationRoot) ---");
  if (!thread) {
    line("  none found. Open a conversation with at least two messages on screen.");
  } else {
    line(`  <${thread.tagName.toLowerCase()}> holding ${bestKids.length} similar children`);
    stableSelector(thread).forEach((sel) => line(`        ${sel}`));
  }

  const messages = bestKids;

  line("");
  line(`--- MESSAGE candidates (${messages.length} in the thread) ---`);
  messages.slice(0, 6).forEach((el, i) => {
    const text = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60);
    line(`  [${i}] ${stableSelector(el).join("  ")}`);
    line(`        text: "${text}..."`);
  });

  // Alternating messages differ somewhere, and that difference is what tells
  // an assistant reply from the user's own. Diff the first two and report it.
  if (messages.length >= 2) {
    const attrsOf = (el) =>
      new Set([
        ...[...el.attributes].map((a) => `${a.name}=${a.value}`),
        ...[...el.classList].map((c) => `class:${c}`),
        ...[...el.querySelectorAll("[data-testid],[data-message-author-role]")]
          .slice(0, 3)
          .flatMap((d) => [...d.attributes].map((a) => `descendant ${a.name}=${a.value}`)),
      ]);
    const a = attrsOf(messages[0]);
    const b = attrsOf(messages[1]);
    const onlyA = [...a].filter((x) => !b.has(x)).slice(0, 6);
    const onlyB = [...b].filter((x) => !a.has(x)).slice(0, 6);
    line("");
    line("--- WHAT DISTINGUISHES MESSAGE 0 FROM MESSAGE 1 ---");
    line("  (one of these is the user, the other the assistant)");
    line(`  only on [0]: ${onlyA.join("  ") || "(nothing)"}`);
    line(`  only on [1]: ${onlyB.join("  ") || "(nothing)"}`);
  }

  // --- what the extension currently expects ---------------------------------
  const CURRENT = {
    "chatgpt.com": {
      composer: ["#prompt-textarea", "div[contenteditable='true'][data-virtualkeyboard]", "form div[contenteditable='true']", "form textarea"],
      conversationRoot: ["main", "div[role='presentation']"],
      assistantMessage: ["[data-message-author-role='assistant']", "div[data-testid^='conversation-turn'] .markdown"],
      userMessage: ["[data-message-author-role='user']"],
    },
    "claude.ai": {
      composer: ["div[contenteditable='true'].ProseMirror", "div[contenteditable='true']", "fieldset textarea"],
      conversationRoot: ["main", "div[data-testid='chat-messages']"],
      assistantMessage: ["[data-testid='assistant-message']", "div.font-claude-message", "div[data-is-streaming='false']"],
      userMessage: ["[data-testid='user-message']", "div.font-user-message"],
    },
  };
  const host = Object.keys(CURRENT).find((h) => location.hostname.endsWith(h));

  line("");
  line("--- DOES THE EXTENSION'S CURRENT GUESS WORK? ---");
  if (!host) {
    line(`  no entry for ${location.hostname} yet`);
  } else {
    for (const [field, sels] of Object.entries(CURRENT[host])) {
      const hit = sels.find((s) => {
        try {
          return document.querySelector(s);
        } catch {
          return false;
        }
      });
      line(`  ${hit ? "OK  " : "MISS"} ${field}: ${hit || sels.join(" | ")}`);
    }
  }

  line("");
  line("Copy everything from OWO SELECTOR PROBE down and paste it back.");
  line("============================================================");
})();
