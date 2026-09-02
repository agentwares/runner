#!/usr/bin/env node
/**
 * Error-ergonomics samples → `errors:<host>`: 10 malformed inputs per tool
 * (generator vendored from packages/mcp-checks), raw responses only — grading
 * happens in agentcheck (heuristic + judge, capped per run).
 *
 *   node scripts/errors.mjs --spec "…" | --url … [--max-tools 25] [--call-timeout 8000]
 */
import { arg, baseCell, commonArgs, emit, fetchJob, hostId, textOf, truncate } from "./lib/cell.mjs";
import { malformedInputs, MALFORMED_CASE_COUNT } from "./lib/malformed.mjs";
import { classifyError, connect, listAllTools } from "./lib/mcp.mjs";

const spec = arg("spec");
const url = arg("url");
const maxTools = Number(arg("max-tools", "25"));
const callTimeout = Number(arg("call-timeout", "8000"));
const budgetMs = Number(arg("budget", "240000"));
const common = commonArgs();
if (!spec && !url) {
  console.error("usage: errors.mjs --spec <spec> | --url <url>");
  process.exit(2);
}
const job = await fetchJob(common.jobUrl, common.secret).catch(() => null);
const host = hostId();
const t0 = Date.now();
let conn;
try {
  conn = await connect({ spec, url, headers: job?.headers ?? {}, timeoutMs: common.timeoutMs });
  const tools = (await listAllTools(conn.client)).slice(0, maxTools);
  const jobs = [];
  for (const t of tools) for (const c of malformedInputs(t.inputSchema)) jobs.push({ tool: t.name, c });
  const samples = [];
  let next = 0;
  const RequestTimeout = -32001;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      if (Date.now() - t0 > budgetMs) {
        samples.push(sample(j, "timeout", "not attempted: run time budget exhausted", 0));
        continue;
      }
      const t1 = Date.now();
      try {
        const result = await conn.client.callTool({ name: j.tool, arguments: j.c.args }, undefined, { timeout: callTimeout });
        const s = sample(j, result.isError ? "error" : "accepted", truncate(textOf(result), result.isError ? 600 : 200), Date.now() - t1);
        if (result.isError && result.structuredContent !== undefined) s.structured = result.structuredContent;
        samples.push(s);
      } catch (e) {
        const ms = Date.now() - t1;
        if (typeof e?.code === "number") {
          const s = sample(j, e.code === RequestTimeout ? "timeout" : "protocol_error", truncate(e.message ?? String(e)), ms);
          s.code = e.code;
          if (e.data !== undefined) s.structured = e.data;
          samples.push(s);
        } else {
          samples.push(sample(j, "transport_error", truncate(e?.message ?? String(e)), ms));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const errors = samples.filter((s) => s.outcome === "error" || s.outcome === "protocol_error").length;
  const transport = samples.filter((s) => s.outcome === "transport_error" || s.outcome === "timeout").length;
  const cell = baseCell(
    `errors:${host}`,
    "errors",
    samples.length === 0 ? "skip" : transport > samples.length / 2 ? "fail" : "pass",
    `${errors} errors / ${samples.length} calls over ${tools.length} tools (ungraded)`,
    { durationMs: Date.now() - t0, detail: { samples, toolCount: tools.length, casesPerTool: MALFORMED_CASE_COUNT } },
  );
  await emit(cell, common);
  await conn.close();
  process.exit(0);
} catch (e) {
  const error = classifyError(e);
  const cell = baseCell(`errors:${host}`, "errors", error.code === "AUTH_REQUIRED" ? "skip" : "fail", `${error.code}: ${error.cause.slice(0, 80)}`, {
    durationMs: Date.now() - t0,
    detail: { samples: [], toolCount: 0, casesPerTool: MALFORMED_CASE_COUNT },
    error,
  });
  await emit(cell, common);
  await conn?.close();
  process.exit(1);
}

function sample(j, outcome, text, durationMs) {
  return { tool: j.tool, caseId: j.c.id, kind: j.c.kind, title: j.c.title, outcome, text, durationMs };
}
