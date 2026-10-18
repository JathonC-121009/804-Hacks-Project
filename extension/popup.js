// Plain JS on purpose: the popup stays usable without a second build target.
//
// It shows one thing — what this browser's AI replies have wasted — because a
// popup people actually read beats a dashboard they scroll past.

const $ = (id) => document.getElementById(id);

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

$("auto").addEventListener("change", (e) => {
  chrome.storage.local.set({ autoDirections: e.target.checked });
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
