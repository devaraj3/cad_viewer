// Bundles tests/*.test.ts with esbuild (already a devDependency) and runs them with node:test.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const testDir = join(root, "tests");
const entries = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join(testDir, f));
const outdir = mkdtempSync(join(tmpdir(), "cad-tests-"));
await build({ entryPoints: entries, outdir, bundle: true, platform: "node", format: "esm", outExtension: { ".js": ".mjs" }, absWorkingDir: root, logLevel: "warning" });
const files = entries.map((e) => join(outdir, e.slice(testDir.length + 1).replace(/\.ts$/, ".mjs")));
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
