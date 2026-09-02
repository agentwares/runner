#!/usr/bin/env node
/**
 * Scripted Claude Code check → `compat:claude-cli@cli:<host>`.
 *
 * Registers the server in an isolated CLAUDE_CONFIG_DIR (`claude mcp add`) and
 * reads `claude mcp list`, which health-checks every configured server: it
 * performs a real `initialize` handshake over the same transport Claude Code
 * uses and prints "✔ Connected" or "✘ Failed to connect". Deterministic, spends
 * no tokens, and needs no ANTHROPIC_API_KEY — so this cell stays inside the
 * pack's cost rule (the only LLM spend in mcpcheck is error grading).
 *
 * `--probe-tools` additionally runs `claude -p` to have the model enumerate the
 * tools it can actually see. That is a real model call, so it is opt-in and can
 * only downgrade a connected server to `warn`, never to `fail` — a slow model
 * turn is our harness's problem, not the publisher's.
 *
 * CLI only, no GUI automation.
 *
 *   node scripts/compat-claude.mjs --spec "…" | --url … [--catalog out/catalog_*.json] [--probe-tools]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { arg, baseCell, commonArgs, emit, fetchJob, flag, hostId } from "./lib/cell.mjs";
import { needsAuth, parseSpec } from "./lib/mcp.mjs";

const spec = arg("spec");
const url = arg("url");
const catalogFile = arg("catalog");
const model = arg("model", process.env.MCPCHECK_CLAUDE_MODEL || "haiku");
const bin = arg("claude", process.env.CLAUDE_BIN || "claude");
const probeTools = flag("probe-tools");
const common = commonArgs();
if (!spec && !url) {
  console.error("usage: compat-claude.mjs --spec <spec> | --url <url>");
  process.exit(2);
}
const job = await fetchJob(common.jobUrl, common.secret).catch(() => null);
const host = hostId();
const id = `compat:claude-cli@cli:${host}`;
const t0 = Date.now();
const SERVER = "target";

const version = spawnSync(bin, ["--version"], { encoding: "utf8" });
if (version.error || version.status !== 0) {
  await emit(
    baseCell(id, "compat", "skip", "claude binary not available on this host", {
      detail: { client: "claude-cli", slot: "cli", version: "unavailable" },
      error: {
        code: "CLAUDE_NOT_FOUND",
        cause: version.error?.message ?? version.stderr ?? "",
        fix: "Install Claude Code on the runner (npm i -g @anthropic-ai/claude-code); `claude mcp list` needs no API key.",
        retryable: false,
      },
    }),
    common,
  );
  process.exit(0);
}
const cliVersion = (version.stdout || "").trim().split(/\s+/)[0] || "unknown";

if (url && (await needsAuth(url, job?.headers ?? {}))) {
  await emit(
    baseCell(id, "compat", "skip", "needs credentials (401): claude -p cannot complete a browser OAuth flow", {
      detail: { client: "claude-cli", slot: "cli", version: cliVersion },
      error: {
        code: "AUTH_REQUIRED",
        cause: "unauthenticated initialize answered 401",
        fix: "Add a bearer token or OAuth refresh credentials to the enrollment; the runner then passes the access token as a header.",
        retryable: false,
      },
    }),
    common,
  );
  process.exit(0);
}

// Isolated config dir + project dir so we never touch the host's own Claude setup.
const dir = mkdtempSync(path.join(tmpdir(), "mcpcheck-claude-"));
const configDir = path.join(dir, "cfg");
mkdirSync(configDir, { recursive: true });
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: configDir,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
const run = (args, extraMs = 0) =>
  spawnSync(bin, args, { encoding: "utf8", cwd: dir, env, timeout: common.timeoutMs + extraMs });

const addArgs = url
  ? [
      "mcp",
      "add",
      "--transport",
      "http",
      SERVER,
      url,
      ...Object.entries(job?.headers ?? {}).flatMap(([k, v]) => ["--header", `${k}: ${v}`]),
    ]
  : (() => {
      const { command, args } = parseSpec(spec);
      return ["mcp", "add", SERVER, "-s", "local", "--", command, ...args];
    })();
const added = run(addArgs);
if (added.status !== 0) {
  await emit(
    baseCell(id, "compat", "fail", `Claude Code ${cliVersion} could not register the server`, {
      durationMs: Date.now() - t0,
      detail: { client: "claude-cli", slot: "cli", version: cliVersion },
      error: {
        code: "CLAUDE_ADD_FAILED",
        cause: `${added.stderr || added.stdout || `exit ${added.status}`}`.slice(0, 500),
        fix: "Check the package spec / URL is well formed: `claude mcp add target -- <command> <args>` must succeed before Claude Code can connect.",
        retryable: false,
      },
    }),
    common,
  );
  process.exit(1);
}

// `mcp list` health-checks every configured server with a real initialize.
const listed = run(["mcp", "list"], 60_000);
// eslint-disable-next-line no-control-regex
const plain = `${listed.stdout || ""}${listed.stderr || ""}`.replace(/\[[0-9;]*m/g, "");
const line = plain.split(/\r?\n/).find((l) => l.trimStart().startsWith(`${SERVER}:`)) ?? "";
const connected = /(?:✔|✓)\s*Connected/i.test(line);
const failedToConnect = /(?:✘|✗|×)\s*Failed to connect/i.test(line);

let known = [];
if (catalogFile) {
  try {
    known = JSON.parse(readFileSync(catalogFile, "utf8")).detail.tools.map((t) => t.name);
  } catch {
    known = [];
  }
}

let reported = null;
let probeCostUsd = null;
let probeRaw = "";
if (connected && probeTools) {
  // Opt-in: a real model call. Let the model take enough turns that "the server
  // is still connecting" is not the answer we end up grading.
  const prompt = `You are connected to one MCP server named "${SERVER}". Without calling any tool, list the names of every tool that server exposes (they appear as mcp__${SERVER}__<tool>). If the server is still connecting, wait and check again before answering. Reply with only a JSON array of the bare tool names, nothing else.`;
  const proc = run(
    [
      "-p",
      prompt,
      "--strict-mcp-config",
      "--output-format",
      "json",
      "--max-turns",
      "6",
      "--model",
      model,
      "--disallowedTools",
      `mcp__${SERVER}__*`,
    ],
    120_000,
  );
  try {
    const out = JSON.parse(proc.stdout);
    probeRaw = String(out.result ?? "");
    probeCostUsd = out.total_cost_usd ?? null;
    const m = probeRaw.match(/\[[\s\S]*\]/);
    const names = m ? JSON.parse(m[0]).map(String) : [];
    reported = known.length ? names.filter((n) => known.includes(n)) : names;
  } catch {
    probeRaw = (proc.stdout || proc.stderr || "").slice(0, 500);
    reported = [];
  }
}

const status = connected ? (reported !== null && reported.length === 0 ? "warn" : "pass") : "fail";
const summary = connected
  ? reported === null
    ? `Claude Code ${cliVersion} connected${known.length ? ` (${known.length} tools in the catalog)` : ""}`
    : reported.length
      ? `Claude Code ${cliVersion} saw ${reported.length}${known.length ? `/${known.length}` : ""} tools`
      : `Claude Code ${cliVersion} connected but the model listed no tools`
  : `Claude Code ${cliVersion} failed to connect`;

const cell = baseCell(id, "compat", status, summary, {
  durationMs: Date.now() - t0,
  detail: {
    client: "claude-cli",
    slot: "cli",
    version: cliVersion,
    connected,
    method: "claude mcp list (health check)",
    ...(known.length ? { toolCount: known.length } : {}),
    ...(reported !== null
      ? { probedTools: reported.slice(0, 100), probeModel: model, probeCostUsd }
      : {}),
    stderrTail: plain.slice(-1000),
  },
  ...(status === "fail"
    ? {
        error: {
          code: failedToConnect ? "CLAUDE_CONNECT_FAILED" : "CLAUDE_STATUS_UNKNOWN",
          cause: (line || plain || `exit ${listed.status}`).trim().slice(0, 500),
          fix: "Run `claude mcp add target -- <your spec>` then `claude mcp list` locally: Claude Code prints the handshake error. On Windows a bare `npx` spec is the usual cause (see the install cell).",
          retryable: true,
        },
      }
    : {}),
  ...(status === "warn"
    ? {
        error: {
          code: "NO_TOOLS_SEEN",
          cause: `handshake succeeded but the model enumerated no tools: ${probeRaw.slice(0, 300)}`,
          fix: "Usually a slow first model turn rather than a server fault — the connection health check above passed.",
          retryable: true,
        },
      }
    : {}),
});
await emit(cell, common);
process.exit(status === "fail" ? 1 : 0);
