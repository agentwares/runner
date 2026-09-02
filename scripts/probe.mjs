#!/usr/bin/env node
/**
 * Clean-install probe → two cells: `install:<host>` (spawn/connect, initialize,
 * tools/list count) and `catalog:<host>` (full tools/list with schemas).
 *
 *   node scripts/probe.mjs --spec "npx -y @org/server" [--out dir] [--timeout 90000]
 *   node scripts/probe.mjs --url https://host/mcp [--job-url …]
 *
 * Also writes the legacy result.json (--legacy-out) for the Wave-0 workflow.
 */
import { writeFileSync } from "node:fs";
import { arg, baseCell, commonArgs, emit, fetchJob, hostId } from "./lib/cell.mjs";
import { classifyError, connect, listAllTools } from "./lib/mcp.mjs";

const spec = arg("spec");
const url = arg("url");
const legacyOut = arg("legacy-out");
const common = commonArgs();
if (!spec && !url) {
  console.error("usage: probe.mjs --spec <spec> | --url <url> [--out dir] [--timeout ms]");
  process.exit(2);
}
const job = await fetchJob(common.jobUrl, common.secret).catch(() => null);
const headers = job?.headers ?? {};
const host = hostId();
const t0 = Date.now();
const specText = spec ?? url;
let conn;
try {
  conn = await connect({ spec, url, headers, timeoutMs: common.timeoutMs });
  const tools = await listAllTools(conn.client);
  const durationMs = Date.now() - t0;
  const caps = conn.client.getServerCapabilities?.() ?? {};
  const catalogTools = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object" },
    ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
    ...(t.annotations && Object.keys(t.annotations).length ? { annotations: t.annotations } : {}),
  }));
  const catalog = baseCell(`catalog:${host}`, "catalog", tools.length ? "pass" : "fail", `${tools.length} tools`, {
    durationMs,
    detail: {
      hash: "",
      tools: catalogTools,
      capturedAt: new Date().toISOString(),
      server: conn.serverVersion,
      protocolVersion: conn.protocolVersion,
    },
    ...(tools.length ? {} : { error: { code: "NO_TOOLS", cause: "tools/list returned an empty list", retryable: false } }),
  });
  const install = baseCell(
    `install:${host}`,
    "install",
    tools.length ? "pass" : "fail",
    tools.length ? `${tools.length} tools in ${(durationMs / 1000).toFixed(1)} s` : "no tools",
    {
      durationMs,
      detail: {
        spec: specText,
        node: process.version,
        arch: process.arch,
        server: conn.serverVersion,
        protocolVersion: conn.protocolVersion,
        toolCount: tools.length,
        capabilities: Object.keys(caps),
        stderrTail: conn.stderr().slice(-1500),
      },
      ...(tools.length ? {} : { error: catalog.error }),
    },
  );
  await emit(install, common);
  await emit(catalog, common);
  if (legacyOut) {
    writeFileSync(
      legacyOut,
      JSON.stringify({ spec: specText, os: process.platform, arch: process.arch, node: process.version, ok: tools.length > 0, durationMs, server: conn.serverVersion, protocolVersion: conn.protocolVersion, toolCount: tools.length, tools: catalogTools.map((t) => ({ name: t.name, description: t.description.slice(0, 200), hasInputSchema: Boolean(t.inputSchema) })), error: install.error ?? null }, null, 2),
    );
  }
  await conn.close();
  process.exit(tools.length ? 0 : 1);
} catch (e) {
  const error = classifyError(e);
  const install = baseCell(`install:${host}`, "install", error.code === "AUTH_REQUIRED" ? "skip" : "fail", error.code === "AUTH_REQUIRED" ? "needs credentials (401)" : `${error.code}: ${error.cause.slice(0, 80)}`, {
    durationMs: Date.now() - t0,
    detail: { spec: specText, node: process.version, arch: process.arch, server: null, toolCount: 0, stderrTail: conn?.stderr().slice(-1500) ?? "" },
    error,
  });
  await emit(install, common);
  if (legacyOut) writeFileSync(legacyOut, JSON.stringify({ spec: specText, os: process.platform, ok: false, error }, null, 2));
  await conn?.close();
  process.exit(1);
}
