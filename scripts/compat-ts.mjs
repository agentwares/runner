#!/usr/bin/env node
/**
 * Client-compat cell with the official TypeScript SDK at N (current) or N-1
 * (`mcp-sdk-prev` alias) → `compat:ts-sdk@<slot>:<host>`.
 *
 *   node scripts/compat-ts.mjs --spec "…" | --url … --slot N|N-1
 */
import { arg, baseCell, commonArgs, emit, fetchJob, hostId } from "./lib/cell.mjs";
import { classifyError, connect, listAllTools } from "./lib/mcp.mjs";

const spec = arg("spec");
const url = arg("url");
const slot = arg("slot", "N");
const common = commonArgs();
if ((!spec && !url) || !["N", "N-1"].includes(slot)) {
  console.error("usage: compat-ts.mjs --spec <spec> | --url <url> --slot N|N-1");
  process.exit(2);
}
const job = await fetchJob(common.jobUrl, common.secret).catch(() => null);
const host = hostId();
const id = `compat:ts-sdk@${slot}:${host}`;
const t0 = Date.now();
let conn;
try {
  conn = await connect({ spec, url, headers: job?.headers ?? {}, slot, timeoutMs: common.timeoutMs, clientName: `agentwares-runner-ts-${slot}` });
  const tools = await listAllTools(conn.client);
  // one real call with the tool's own example-free shape: an empty-args call must not crash the transport
  let callOk = true;
  let callNote = "";
  if (tools[0]) {
    try {
      await conn.client.callTool({ name: tools[0].name, arguments: {} }, undefined, { timeout: 8000 });
    } catch (e) {
      callOk = typeof e?.code === "number"; // a JSON-RPC error is a healthy answer; a transport failure is not
      callNote = ` · first call: ${e?.message?.slice(0, 80) ?? e}`;
    }
  }
  const status = tools.length && callOk ? "pass" : "fail";
  const cell = baseCell(id, "compat", status, `${tools.length} tools via ts-sdk ${conn.sdkVersion}${callNote}`, {
    durationMs: Date.now() - t0,
    detail: { client: "ts-sdk", slot, version: conn.sdkVersion, toolCount: tools.length, protocolVersion: conn.protocolVersion },
    ...(status === "fail" ? { error: { code: tools.length ? "CALL_TRANSPORT_FAILED" : "NO_TOOLS", cause: callNote || "tools/list empty", retryable: true } } : {}),
  });
  await emit(cell, common);
  await conn.close();
  process.exit(status === "pass" ? 0 : 1);
} catch (e) {
  const error = classifyError(e);
  const cell = baseCell(id, "compat", "fail", `${error.code}: ${error.cause.slice(0, 80)}`, {
    durationMs: Date.now() - t0,
    detail: { client: "ts-sdk", slot, version: "unknown", stderrTail: conn?.stderr().slice(-1000) ?? "" },
    error,
  });
  await emit(cell, common);
  await conn?.close();
  process.exit(1);
}
