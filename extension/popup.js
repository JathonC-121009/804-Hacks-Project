// Plain JS on purpose: the popup has no logic worth a build step.
const $ = (id) => document.getElementById(id);

chrome.storage.local.get(["wasted", "total", "replies"], (s) => {
  const wasted = s.wasted ?? 0;
  const total = s.total ?? 0;
  $("replies").textContent = String(s.replies ?? 0);
  $("total").textContent = total.toLocaleString();
  $("wasted").textContent = wasted.toLocaleString();
  $("eff").textContent = total > 0 ? `${Math.round((1 - wasted / total) * 100)}%` : "—";
});

chrome.storage.local.get(["autoDirections"], (s) => {
  $("auto").checked = s.autoDirections === true;
});
$("auto").addEventListener("change", (e) => {
  chrome.storage.local.set({ autoDirections: e.target.checked });
});

$("reset").addEventListener("click", () => {
  chrome.storage.local.set({ wasted: 0, total: 0, replies: 0 }, () => location.reload());
});
