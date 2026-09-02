#!/usr/bin/env node
/**
 * Generic scenarios of @modelcontextprotocol/conformance against a remote URL
 * → `conformance:<host>`. (The suite's auth/* scenarios test clients, so OAuth
 * for servers is checked by agentcheck's tick instead.)
 *
 *   node scripts/conformance.mjs --url https://host/mcp [--scenarios server-initialize,ping,tools-list]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { arg, baseCell, commonArgs, emit, hostId } from "./lib/cell.mjs";

const CONFORMANCE = "@modelcontextprotocol/conformance@0.1.16";
const url = arg("url");
const scenarios = arg("scenarios", "server-initialize,ping,tools-list").split(",");
const common = commonArgs();
if (!url) {
  console.error("usage: conformance.mjs --url <url>");
  process.exit(2);
}
const host = hostId();
const id = `conformance:${host}`;
const t0 = Date.now();
const results = [];
for (const scenario of scenarios) {
  const outDir = mkdtempSync(path.join(tmpdir(), "mcpcheck-conf-"));
  const proc = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["-y", CONFORMANCE, "server", "--url", url, "--scenario", scenario, "--output-dir", outDir], {
    encoding: "utf8",
    timeout: common.timeoutMs,
    env: { ...process.env, npm_config_yes: "true" },
  });
  let status = proc.status === 0 ? "pass" : "fail";
  let message = "";
  try {
    for (const f of readdirSync(outDir)) {
      if (!f.endsWith(".json")) continue;
      const data = JSON.parse(readFileSync(path.join(outDir, f), "utf8"));
      const entry = Array.isArray(data.results) ? data.results.find((r) => r.name === scenario) ?? data.results[0] : data;
      if (entry?.status) status = entry.status === "PASSED" || entry.status === "pass" ? "pass" : entry.status === "SKIPPED" ? "skip" : "fail";
      if (Array.isArray(entry?.errors) && entry.errors.length) message = entry.errors.join("; ").slice(0, 300);
      if (Array.isArray(entry?.checks)) {
        const failed = entry.checks.filter((c) => c.status !== "PASSED" && c.status !== "pass");
        if (failed.length) message = failed.map((c) => `${c.name}: ${c.message ?? ""}`).join("; ").slice(0, 300);
      }
    }
  } catch {
    // fall back to exit code + stdout tail
  }
  if (!message && status === "fail") message = ((proc.stderr || "") + (proc.stdout || "")).trim().split("\n").slice(-3).join(" ").slice(0, 300);
  results.push({ name: scenario, status, message });
}
const failed = results.filter((r) => r.status === "fail").length;
const cell = baseCell(id, "conformance", failed ? "fail" : "pass", `${results.length - failed}/${results.length} scenarios pass (${CONFORMANCE.split("@").pop()})`, {
  durationMs: Date.now() - t0,
  detail: { version: CONFORMANCE.split("@").pop(), scenarios: results },
});
await emit(cell, common);
process.exit(failed ? 1 : 0);
