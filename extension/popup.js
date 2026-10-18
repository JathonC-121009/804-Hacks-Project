// Plain JS on purpose: the popup stays out of the TypeScript build. It does
// import the compiled core for auth, so the popup, the content script and the
// CLI all sign in through exactly one code path.
//
// What it shows is deliberately one thing — what this browser's AI replies have
// wasted — because a popup people actually read beats a dashboard they scroll
// past. Sign-in and per-site activation sit below that, out of the way.
import {
  isFirebaseConfigured,
  signInWithPassword,
} from "./dist/packages/core/src/firestore.js";

const $ = (id) => document.getElementById(id);

const BUILT_IN_HOSTS = [
  "chatgpt.com",
  "chat.openai.com",
  "claude.ai",
  "gemini.google.com",
  "perplexity.ai",
  "copilot.microsoft.com",
  "grok.com",
  "x.com",
  "poe.com",
  "chat.deepseek.com",
  "chat.mistral.ai",
  "meta.ai",
  "you.com",
];

const zeroRange = (unit) => ({ low: 0, high: 0, unit });

const emptyResources = () => ({
  energyWh: zeroRange("Wh"),
  waterMl: zeroRange("mL"),
  co2g: zeroRange("g"),
});

function sig(n) {
  if (n === 0) return "0";
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
  return String(Number(n.toPrecision(2)));
}

/** Auto-scale the unit so a reading of 0.0003 Wh reads as 0.3 mWh, not zeros. */
function rescale(range) {
  const peak = Math.max(Math.abs(range.low), Math.abs(range.high));
  if (range.unit === "Wh" && peak > 0 && peak < 1) {
    return { low: range.low * 1000, high: range.high * 1000, unit: "mWh" };
  }
  if (range.unit === "Wh" && peak >= 1000) {
    return { low: range.low / 1000, high: range.high / 1000, unit: "kWh" };
  }
  if (range.unit === "mL" && peak >= 1000) {
    return { low: range.low / 1000, high: range.high / 1000, unit: "L" };
  }
  if (range.unit === "g" && peak > 0 && peak < 1) {
    return { low: range.low * 1000, high: range.high * 1000, unit: "mg" };
  }
  return range;
}

/** The only way a figure reaches the popup. Never prints a bare number. */
function formatRange(range) {
  const r = rescale(range);
  return r.low === r.high ? `${sig(r.low)} ${r.unit}` : `${sig(r.low)}–${sig(r.high)} ${r.unit}`;
}

function resourcesFromTokens(tokens, sources) {
  const energyWh = {
    low: tokens * sources.e_out_large.low,
    high: tokens * sources.e_out_large.high,
    unit: "Wh",
  };
  return {
    energyWh,
    waterMl: {
      low: (energyWh.low / 1000) * sources.WI.low,
      high: (energyWh.high / 1000) * sources.WI.high,
      unit: "mL",
    },
    co2g: {
      low: (energyWh.low / 1000) * sources.grid_fallback.low,
      high: (energyWh.high / 1000) * sources.grid_fallback.high,
      unit: "g",
    },
  };
}

/**
 * Earlier versions stored token counters only. Rebuild their resource ranges
 * once so upgrading does not make the popup look empty. Safe to assume the
 * large-model constants: every site config uses that class.
 */
async function migrateTokenOnlyHistory(total, wasted) {
  try {
    const response = await fetch(chrome.runtime.getURL("config/sources.json"));
    if (!response.ok) return null;
    const sources = await response.json();
    return {
      resourcesTotal: resourcesFromTokens(total, sources),
      resourcesWasted: resourcesFromTokens(wasted, sources),
    };
  } catch {
    return null;
  }
}

function renderWaste(resources) {
  $("w-energy").textContent = formatRange(resources.energyWh);
  $("w-water").textContent = formatRange(resources.waterMl);
  $("w-co2").textContent = formatRange(resources.co2g);
}

chrome.storage.local.get(
  ["wasted", "total", "replies", "resourcesWasted"],
  (s) => {
    const wasted = s.wasted ?? 0;
    const total = s.total ?? 0;
    const replies = s.replies ?? 0;

    $("eff").textContent = total > 0 ? `${Math.round((1 - wasted / total) * 100)}%` : "—";
    $("w-tokens").textContent = wasted.toLocaleString();
    renderWaste(s.resourcesWasted ?? emptyResources());

    if (total === 0) {
      $("rows").classList.add("dim");
      $("caption").textContent =
        "No replies measured yet. Open ChatGPT or Claude with the extension on.";
      return;
    }

    $("caption").textContent =
      `${wasted.toLocaleString()} of ${total.toLocaleString()} output tokens across ` +
      `${replies} ${replies === 1 ? "reply" : "replies"}. Estimated locally, shown as ranges.`;

    if (!s.resourcesWasted) {
      void migrateTokenOnlyHistory(total, wasted).then((migrated) => {
        if (!migrated) return;
        renderWaste(migrated.resourcesWasted);
        chrome.storage.local.set(migrated);
      });
    }
  },
);

chrome.storage.local.get(["autoDirections"], (s) => {
  $("auto").checked = s.autoDirections === true;
});

async function firebaseConfig() {
  const response = await fetch(chrome.runtime.getURL("config/firebase.json"));
  if (!response.ok) throw new Error("config/firebase.json is missing from the extension build.");
  const config = await response.json();
  if (!isFirebaseConfigured(config)) {
    throw new Error("Firebase is not configured yet. Fill in config/firebase.json and rebuild.");
  }
  return config;
}

function showSignedIn(email) {
  $("sync-form").hidden = true;
  $("sign-in").hidden = true;
  $("sign-out").hidden = false;
  $("sync-status").textContent = `Signed in as ${email}. New replies sync automatically.`;
  $("sync-status").dataset.state = "ok";
}

function showSignedOut(message = "") {
  $("sync-form").hidden = false;
  $("sign-in").hidden = false;
  $("sign-out").hidden = true;
  $("sync-status").textContent = message;
}

chrome.storage.local.get(["pfSession", "pfEmail"], (s) => {
  if (s.pfSession?.refreshToken) showSignedIn(s.pfEmail ?? "your account");
  else showSignedOut();
});

$("sign-in").addEventListener("click", async () => {
  const email = $("sync-email").value.trim();
  const password = $("sync-password").value;
  const status = $("sync-status");
  status.dataset.state = "";
  if (!email || !password) {
    status.textContent = "Enter the email and password for your dashboard account.";
    status.dataset.state = "error";
    return;
  }
  $("sign-in").disabled = true;
  status.textContent = "Signing in…";
  try {
    const config = await firebaseConfig();
    const session = await signInWithPassword(config.apiKey, email, password);
    await chrome.storage.local.set({ pfSession: session, pfEmail: email });
    $("sync-password").value = "";
    showSignedIn(email);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Sign-in failed.";
    status.dataset.state = "error";
  } finally {
    $("sign-in").disabled = false;
  }
});

$("sign-out").addEventListener("click", async () => {
  await chrome.storage.local.remove(["pfSession", "pfEmail"]);
  showSignedOut("Signed out. Measurements stay on this device.");
});

$("auto").addEventListener("change", (e) => {
  chrome.storage.local.set({ autoDirections: e.target.checked });
});

function isBuiltInHost(hostname) {
  return BUILT_IN_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function scriptIdFor(hostname) {
  return `owo-${hostname.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 80)}`;
}

function setSiteStatus(message, state = "") {
  $("site-status").textContent = message;
  $("site-status").dataset.state = state;
}

async function activeWebTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !tab.url) return null;
  try {
    const url = new URL(tab.url);
    if (url.protocol !== "https:") return null;
    return { id: tab.id, url };
  } catch {
    return null;
  }
}

async function refreshSiteControl() {
  const tab = await activeWebTab();
  if (!tab) {
    $("enable-site").disabled = true;
    setSiteStatus("Open an HTTPS AI chat page to enable it.");
    return;
  }
  if (isBuiltInHost(tab.url.hostname)) {
    $("site-heading").textContent = "Current AI tool";
    $("site-help").textContent = "Activate the analyzer immediately on this open chat page.";
    $("enable-site").disabled = false;
    $("enable-site").textContent = "Activate on this page";
    setSiteStatus("Dedicated support is available. Use Activate after reloading the extension.", "ok");
    return;
  }

  const originPattern = `${tab.url.origin}/*`;
  const allowed = await chrome.permissions.contains({ origins: [originPattern] });
  if (allowed) {
    $("enable-site").textContent = "Enabled on this site";
    setSiteStatus("Generic chat detection is active for this site.", "ok");
  }
}

$("enable-site").addEventListener("click", async () => {
  const button = $("enable-site");
  button.disabled = true;
  setSiteStatus("Waiting for site permission…");

  try {
    const tab = await activeWebTab();
    if (!tab) throw new Error("Open an HTTPS AI chat page first.");
    if (isBuiltInHost(tab.url.hostname)) {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["overlay.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["loader.js"] });
      button.textContent = "Active on this page";
      setSiteStatus("The analyzer is active. Existing drafts are checked immediately.", "ok");
      return;
    }

    const originPattern = `${tab.url.origin}/*`;
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) throw new Error("Site access was not granted.");

    const id = scriptIdFor(tab.url.hostname);
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (existing.length === 0) {
      await chrome.scripting.registerContentScripts([
        {
          id,
          matches: [originPattern],
          js: ["loader.js"],
          css: ["overlay.css"],
          runAt: "document_idle",
          persistAcrossSessions: true,
        },
      ]);
    }

    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["overlay.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["loader.js"] });
    button.textContent = "Enabled on this site";
    setSiteStatus("Generic chat detection is active. Refresh if the page was already open for a while.", "ok");
  } catch (error) {
    button.disabled = false;
    setSiteStatus(error instanceof Error ? error.message : "Could not enable this site.", "error");
  }
});

$("reset").addEventListener("click", () => {
  chrome.storage.local.set(
    {
      wasted: 0,
      total: 0,
      replies: 0,
      resourcesTotal: emptyResources(),
      resourcesWasted: emptyResources(),
      // Also forget which waste types were seen, or the pre-send directions
      // keep targeting problems whose evidence the user just cleared.
      wasteByType: {},
    },
    () => location.reload(),
  );
});

void refreshSiteControl();
