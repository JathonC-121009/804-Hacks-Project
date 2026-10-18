/**
 * Dev server for the portal. Run: npm run dev
 *
 * Why a hand-rolled 100-line server instead of a bundler:
 *
 * The demo has one chance to run, on conference wifi, on a machine that may not
 * be the one it was built on. A build step is a thing that can fail at 7:55.
 * Node 22 can strip TypeScript types itself, so this server serves .ts files as
 * JavaScript on the fly and the browser imports the same source the tests run
 * against. No build, no node_modules, no lockfile, nothing to install.
 *
 * It only serves files from the repo, read-only, on localhost.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const PORT = Number(process.env["PORT"] ?? 5173);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const server = createServer(async (req, res) => {
  try {
    const requested = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    const path = requested === "/" ? "/apps/portal/index.html" : requested;

    const resolved = safeResolve(path);
    if (!resolved) {
      res.writeHead(403, { "content-type": "text/plain" }).end("Outside the project root.");
      return;
    }

    const info = await stat(resolved).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end(`Not found: ${path}`);
      return;
    }

    const ext = extname(resolved);

    // The one interesting case: hand the browser JavaScript, from TypeScript on
    // disk, with no build artefact in between.
    if (ext === ".ts") {
      const source = await readFile(resolved, "utf8");
      const js = stripTypeScriptTypes(source, { mode: "strip" });
      res
        .writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        })
        .end(js);
      return;
    }

    res
      .writeHead(200, {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": "no-store",
      })
      .end(await readFile(resolved));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "text/plain" }).end("Server error. See the terminal.");
  }
});

/** Resolve inside ROOT only, so a crafted path cannot escape the repo. */
function safeResolve(urlPath: string): string | null {
  const resolved = resolve(join(ROOT, normalize(urlPath)));
  if (resolved !== ROOT && !resolved.startsWith(ROOT + sep)) return null;
  return resolved;
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Output-Waste Optimizer portal:  http://127.0.0.1:${PORT}/`);
  console.log("Serving TypeScript straight to the browser with type stripping. No build step.");
  console.log("Ctrl-C to stop.");
});
