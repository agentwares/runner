#!/usr/bin/env node
/**
 * Clean-install probe: spawn an MCP server from a package spec over stdio,
 * initialize, list tools, and write a JSON result.
 *
 *   node scripts/probe.mjs --spec "npx -y @org/server" --out result.json [--timeout 90000]
 *
 * Spec forms: "npx [-y] <pkg> [args]", "uvx <pkg> [args]", or any "<cmd> [args]".
 * On Windows, npx/uvx resolve to their .cmd shims (the classic ENOENT).
 */
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const spec = arg("spec");
const out = arg("out", "result.json");
const timeoutMs = Number(arg("timeout", "90000"));
if (!spec) {
  console.error("usage: probe.mjs --spec <spec> [--out file] [--timeout ms]");
  process.exit(2);
}

const tokens = spec.match(/(?:[^\s"]+|"[^"]*")+/g).map((t) => t.replace(/^"|"$/g, ""));
let [command, ...args] = tokens;
if (process.platform === "win32" && ["npx", "npm", "uvx", "pnpm"].includes(command)) {
  command = `${command}.cmd`;
}

const result = {
  spec,
  os: process.platform,
  arch: process.arch,
  node: process.version,
  startedAt: new Date().toISOString(),
  ok: false,
  durationMs: 0,
  server: null,
  protocolVersion: null,
  tools: [],
  toolCount: 0,
  error: null,
};

const t0 = Date.now();
const transport = new StdioClientTransport({ command, args, stderr: "pipe" });
let stderr = "";
transport.stderr?.on("data", (d) => {
  stderr += String(d);
  if (stderr.length > 8000) stderr = stderr.slice(-8000);
});
const client = new Client({ name: "agentwares-runner", version: "0.1.0" });

const timer = setTimeout(() => {
  result.error = { code: "TIMEOUT", cause: `no initialize/tools.list within ${timeoutMs}ms`, stderr };
  finish(1);
}, timeoutMs);

async function finish(code) {
  clearTimeout(timer);
  result.durationMs = Date.now() - t0;
  try {
    await client.close();
  } catch {
    /* ignore */
  }
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, toolCount: result.toolCount, durationMs: result.durationMs, error: result.error?.code ?? null }));
  process.exit(code);
}

try {
  await client.connect(transport);
  const sv = client.getServerVersion();
  result.server = sv ? { name: sv.name, version: sv.version } : null;
  const caps = client.getServerCapabilities();
  result.capabilities = caps ? Object.keys(caps) : [];
  const { tools } = await client.listTools();
  result.tools = tools.map((t) => ({
    name: t.name,
    description: (t.description ?? "").slice(0, 200),
    hasInputSchema: Boolean(t.inputSchema),
    annotations: t.annotations ?? null,
  }));
  result.toolCount = tools.length;
  result.ok = tools.length > 0;
  if (!result.ok) result.error = { code: "NO_TOOLS", cause: "tools/list returned an empty list", stderr };
  await finish(result.ok ? 0 : 1);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  const code = /ENOENT/.test(msg) ? "SPAWN_ENOENT" : /timed out|timeout/i.test(msg) ? "TIMEOUT" : "CONNECT_FAILED";
  result.error = { code, cause: msg.slice(0, 500), stderr };
  await finish(1);
}
