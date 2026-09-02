#!/usr/bin/env node
/**
 * Scripted Claude Code check → `compat:claude-cli@cli:<host>`: write an
 * --mcp-config for the server, run `claude -p` non-interactively and ask it to
 * name the server's tools; pass when it reports ≥ 1 tool that exists in tools/list.
 * CLI only, no GUI automation. Needs the `claude` binary and ANTHROPIC_API_KEY
 * (API billing) on the runner; locally it uses whatever `claude` is logged in as.
 *
 *   node scripts/compat-claude.mjs --spec "…" | --url … [--catalog out/catalog_*.json] [--model claude-haiku-4-5]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { arg, baseCell, commonArgs, emit, fetchJob, hostId } from "./lib/cell.mjs";
import { needsAuth, parseSpec } from "./lib/mcp.mjs";

const spec = arg("spec");
const url = arg("url");
const catalogFile = arg("catalog");
const model = arg("model", process.env.MCPCHECK_CLAUDE_MODEL || "haiku");
const bin = arg("claude", process.env.CLAUDE_BIN || "claude");
const common = commonArgs();
if (!spec && !url) {
  console.error("usage: compat-claude.mjs --spec <spec> | --url <url>");
  process.exit(2);
}
const job = await fetchJob(common.jobUrl, common.secret).catch(() => null);
const host = hostId();
const id = `compat:claude-cli@cli:${host}`;
const t0 = Date.now();

const version = spawnSync(bin, ["--version"], { encoding: "utf8" });
if (version.error || version.status !== 0) {
  const cell = baseCell(id, "compat", "skip", "claude binary not available on this host", {
    detail: { client: "claude-cli", slot: "cli", version: "unavailable" },
    error: { code: "CLAUDE_NOT_FOUND", cause: version.error?.message ?? version.stderr ?? "", fix: "Install Claude Code on the runner (npm i -g @anthropic-ai/claude-code) and set ANTHROPIC_API_KEY.", retryable: false },
  });
  await emit(cell, common);
  process.exit(0);
}
const cliVersion = (version.stdout || "").trim().split(/\s+/)[0] || "unknown";
if (url && (await needsAuth(url, job?.headers ?? {}))) {
  const cell = baseCell(id, "compat", "skip", "needs credentials (401): claude -p cannot complete a browser OAuth flow", {
    detail: { client: "claude-cli", slot: "cli", version: cliVersion },
    error: { code: "AUTH_REQUIRED", cause: "unauthenticated initialize answered 401", fix: "Add a bearer token or OAuth refresh credentials to the enrollment; the runner then passes the access token as a header.", retryable: false },
  });
  await emit(cell, common);
  process.exit(0);
}

const serverName = "target";
const serverConfig = url
  ? { type: "http", url, headers: job?.headers ?? {} }
  : (() => {
      const { command, args } = parseSpec(spec);
      return { type: "stdio", command, args };
    })();
const dir = mkdtempSync(path.join(tmpdir(), "mcpcheck-claude-"));
const cfg = path.join(dir, "mcp.json");
writeFileSync(cfg, JSON.stringify({ mcpServers: { [serverName]: serverConfig } }));

let known = [];
if (catalogFile) {
  try {
    known = JSON.parse(readFileSync(catalogFile, "utf8")).detail.tools.map((t) => t.name);
  } catch {
    known = [];
  }
}
const prompt = `You are connected to one MCP server named "${serverName}". Without calling any tool, list the names of every tool that server exposes (they appear as mcp__${serverName}__<tool>). Reply with only a JSON array of the bare tool names, nothing else.`;
const proc = spawnSync(
  bin,
  ["-p", prompt, "--mcp-config", cfg, "--strict-mcp-config", "--output-format", "json", "--max-turns", "2", "--model", model, "--disallowedTools", `mcp__${serverName}__*`],
  { encoding: "utf8", timeout: common.timeoutMs + 60_000, cwd: dir, env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } },
);
let reported = [];
let raw = "";
let costUsd = null;
try {
  const out = JSON.parse(proc.stdout);
  raw = String(out.result ?? "");
  costUsd = out.total_cost_usd ?? null;
  const m = raw.match(/\[[\s\S]*\]/);
  reported = m ? JSON.parse(m[0]).map(String) : [];
} catch {
  raw = (proc.stdout || "").slice(0, 500);
}
const matched = known.length ? reported.filter((n) => known.includes(n)) : reported;
const ok = proc.status === 0 && matched.length > 0;
const cell = baseCell(id, "compat", ok ? "pass" : "fail", ok ? `Claude Code ${cliVersion} saw ${matched.length}${known.length ? `/${known.length}` : ""} tools` : `Claude Code ${cliVersion} reported no tools`, {
  durationMs: Date.now() - t0,
  detail: { client: "claude-cli", slot: "cli", version: cliVersion, toolCount: matched.length, reported: reported.slice(0, 100), model, costUsd, stderrTail: (proc.stderr || "").slice(-1000) },
  ...(ok ? {} : { error: { code: proc.status === 0 ? "NO_TOOLS_SEEN" : "CLAUDE_FAILED", cause: (raw || proc.stderr || `exit ${proc.status}`).slice(0, 500), fix: "Run `claude --mcp-config mcp.json --strict-mcp-config` and `/mcp` interactively to see the connection error Claude Code reports.", retryable: true } }),
});
await emit(cell, common);
process.exit(ok ? 0 : 1);
