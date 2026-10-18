/**
 * MV3 content scripts cannot be ES modules, but they can dynamically import one.
 * This three-line shim is the whole reason the extension can share the exact
 * same engine the tests run against, instead of a second copy that drifts.
 */
import(chrome.runtime.getURL("dist/extension/src/content.js")).catch((err) => {
  console.error("[Output-Waste Optimizer] failed to load. Run `npm run build:ext`.", err);
});
