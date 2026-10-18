// Plain JS on purpose: the popup stays usable without a second build target.
const $ = (id) => document.getElementById(id);

const zeroRange = (unit) => ({ low: 0, high: 0, unit });

function sig(n) {
  if (n === 0) return "0";
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
  return String(Number(n.toPrecision(2)));
}

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

function formatRange(range) {
  const scaled = rescale(range);
  return scaled.low === scaled.high
    ? `${sig(scaled.low)} ${scaled.unit}`
    : `${sig(scaled.low)}–${sig(scaled.high)} ${scaled.unit}`;
}

function renderResource(id, total, wasted) {
  $(`${id}-total`).textContent = formatRange(total);
  $(`${id}-wasted`).textContent = `${formatRange(wasted)} waste`;
}

function emptyResources() {
  return {
    energyWh: zeroRange("Wh"),
    waterMl: zeroRange("mL"),
    co2g: zeroRange("g"),
  };
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

chrome.storage.local.get(
  ["wasted", "total", "replies", "resourcesTotal", "resourcesWasted"],
  (s) => {
  const wasted = s.wasted ?? 0;
  const total = s.total ?? 0;
  let resourcesTotal = s.resourcesTotal ?? emptyResources();
  let resourcesWasted = s.resourcesWasted ?? emptyResources();

  $("replies").textContent = String(s.replies ?? 0);
  $("total").textContent = total.toLocaleString();
  $("wasted").textContent = wasted.toLocaleString();
  $("eff").textContent = total > 0 ? `${Math.round((1 - wasted / total) * 100)}%` : "—";
  renderResource("energy", resourcesTotal.energyWh, resourcesWasted.energyWh);
  renderResource("water", resourcesTotal.waterMl, resourcesWasted.waterMl);
  renderResource("co2", resourcesTotal.co2g, resourcesWasted.co2g);

  if (total === 0) {
    $("empty").hidden = false;
    $("resource-grid").classList.add("is-empty");
  } else if (!s.resourcesTotal || !s.resourcesWasted) {
    // Earlier extension versions stored token counters only. Reconstruct their
    // resource ranges once so an upgrade does not make the dashboard look empty.
    void migrateTokenOnlyHistory(total, wasted).then((migrated) => {
      if (!migrated) return;
      resourcesTotal = migrated.resourcesTotal;
      resourcesWasted = migrated.resourcesWasted;
      renderResource("energy", resourcesTotal.energyWh, resourcesWasted.energyWh);
      renderResource("water", resourcesTotal.waterMl, resourcesWasted.waterMl);
      renderResource("co2", resourcesTotal.co2g, resourcesWasted.co2g);
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
    },
    () => location.reload(),
  );
});
