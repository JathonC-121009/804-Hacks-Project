import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const OUT = join(ROOT, "dist", "web");

async function compileTree(sourceRoot: string): Promise<void> {
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    const source = join(sourceRoot, entry.name);
    if (entry.isDirectory()) {
      await compileTree(source);
      continue;
    }
    if (extname(source) !== ".ts") continue;
    const destination = join(OUT, relative(ROOT, source)).replace(/\.ts$/, ".js");
    const stripped = stripTypeScriptTypes(await readFile(source, "utf8"), { mode: "strip" })
      .replace(/(["'])((?:\.\.\/|\.\/)[^"']+)\.ts\1/g, "$1$2.js$1");
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, stripped);
  }
}

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, "apps", "portal"), { recursive: true });
await mkdir(join(OUT, "data"), { recursive: true });
await Promise.all([
  compileTree(join(ROOT, "apps", "portal")),
  compileTree(join(ROOT, "packages", "core", "src")),
  cp(join(ROOT, "apps", "portal", "style.css"), join(OUT, "apps", "portal", "style.css")),
  cp(join(ROOT, "config"), join(OUT, "config"), { recursive: true }),
  cp(join(ROOT, "data", "grid_pjm.json"), join(OUT, "data", "grid_pjm.json"), { recursive: true }),
]);

const html = (await readFile(join(ROOT, "apps", "portal", "index.html"), "utf8"))
  .replace("/apps/portal/app.ts", "/apps/portal/app.js");
await writeFile(join(OUT, "apps", "portal", "index.html"), html);
await writeFile(join(OUT, "index.html"), html);
console.log(`Built Firebase Hosting site: ${relative(ROOT, OUT)}/`);
