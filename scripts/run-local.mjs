#!/usr/bin/env node
/**
 * Run the whole cell pipeline for one server on this machine — the same
 * scripts the Actions matrix runs, one OS at a time. Used for the acceptance
 * corpus (5 public servers on macOS) and for debugging an enrollment.
 *
 *   node scripts/run-local.mjs --spec "npx -y @org/server" --slug org-server [--cells install,errors,compat-ts,compat-py,claude,conformance]
 *   node scripts/run-local.mjs --url https://host/mcp --slug host
 *
 * Python cells need --python-n / --python-prev (venvs with mcp==N / N-1) or uv.
 * Every cell lands in out/<slug>/<cell>.json; --callback/--target-id/--run-key post them too.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arg } from "./lib/cell.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = arg("spec");
const url = arg("url");
const slug = arg("slug", "server");
const outDir = arg("out", path.join("out", slug));
const cells = arg("cells", "install,errors,compat-ts,compat-py,claude,conformance").split(",");
const pythonN = arg("python-n", process.env.MCPCHECK_PYTHON_N);
const pythonPrev = arg("python-prev", process.env.MCPCHECK_PYTHON_PREV);
const passthrough = [];
for (const k of ["callback", "target-id", "run-key", "job-url", "timeout"]) {
  const v = arg(k);
  if (v) passthrough.push(`--${k}`, v);
}
if (!spec && !url) {
  console.error("usage: run-local.mjs --spec <spec> | --url <url> --slug <slug>");
  process.exit(2);
}
const target = url ? ["--url", url] : ["--spec", spec];
const steps = [];
if (cells.includes("install")) steps.push(["probe.mjs", []]);
if (cells.includes("errors")) steps.push(["errors.mjs", []]);
if (cells.includes("compat-ts")) steps.push(["compat-ts.mjs", ["--slot", "N"]], ["compat-ts.mjs", ["--slot", "N-1"]]);
if (cells.includes("compat-py")) {
  steps.push(["compat-py.mjs", ["--slot", "N", ...(pythonN ? ["--python", pythonN] : ["--mcp-version", process.env.MCP_PY_N || "2.1.1"])]]);
  steps.push(["compat-py.mjs", ["--slot", "N-1", ...(pythonPrev ? ["--python", pythonPrev] : ["--mcp-version", process.env.MCP_PY_PREV || "2.0.1"])]]);
}
if (cells.includes("claude")) steps.push(["compat-claude.mjs", ["--catalog", "__CATALOG__"]]);
if (cells.includes("conformance") && url) steps.push(["conformance.mjs", []]);

const summary = [];
for (const [script, extra] of steps) {
  const args = extra.map((a) => (a === "__CATALOG__" ? findCatalog(outDir) ?? "" : a)).filter((a, i, all) => !(a === "" && all[i - 1] === "--catalog"));
  const finalArgs = args.includes("--catalog") ? args : args.filter((a) => a !== "--catalog");
  const t0 = Date.now();
  const proc = spawnSync(process.execPath, [path.join(here, script), ...target, "--out", outDir, ...finalArgs, ...passthrough], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const line = (proc.stdout || "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
  let parsed = null;
  try {
    parsed = line ? JSON.parse(line) : null;
  } catch {
    parsed = null;
  }
  summary.push({ script, args: finalArgs.join(" "), exit: proc.status, status: parsed?.status ?? "?", summary: parsed?.summary ?? (proc.stderr || "").trim().split("\n").pop()?.slice(0, 120), ms: Date.now() - t0 });
  console.log(`${parsed?.status?.padEnd(7) ?? "?      "} ${script} ${finalArgs.join(" ")} — ${parsed?.summary ?? ""}`);
}
console.log(JSON.stringify({ slug, outDir, cells: summary }, null, 2));

function findCatalog(dir) {
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => n.startsWith("catalog_"));
  return f ? path.join(dir, f) : null;
}
