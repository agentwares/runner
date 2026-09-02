#!/usr/bin/env node
/**
 * Client-compat cell with the official Python SDK → `compat:py-sdk@<slot>:<host>`.
 * Runs scripts/compat_py.py under a Python that has `mcp` installed:
 *   --python <bin>   explicit interpreter (local venvs)
 *   otherwise `uv run --with mcp==<ver>` when uv is available (Actions)
 *
 *   node scripts/compat-py.mjs --spec "…" | --url … --slot N|N-1 [--python …] [--mcp-version 2.1.1]
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { arg, baseCell, commonArgs, emit, fetchJob, hostId } from "./lib/cell.mjs";

const spec = arg("spec");
const url = arg("url");
const slot = arg("slot", "N");
const python = arg("python");
const mcpVersion = arg("mcp-version");
const common = commonArgs();
if ((!spec && !url) || !["N", "N-1"].includes(slot)) {
  console.error("usage: compat-py.mjs --spec <spec> | --url <url> --slot N|N-1 [--python bin]");
  process.exit(2);
}
const job = await fetchJob(common.jobUrl, common.secret).catch(() => null);
const host = hostId();
const id = `compat:py-sdk@${slot}:${host}`;
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "compat_py.py");
const pyArgs = [script, ...(url ? ["--url", url] : ["--spec", spec]), "--timeout", String(common.timeoutMs / 1000)];
if (job?.headers && Object.keys(job.headers).length) pyArgs.push("--headers-json", JSON.stringify(job.headers));

let cmd;
let args;
if (python) {
  cmd = python;
  args = pyArgs;
} else {
  cmd = process.platform === "win32" ? "uv.exe" : "uv";
  args = ["run", "--no-project", "--with", mcpVersion ? `mcp==${mcpVersion}` : "mcp", "python", ...pyArgs];
}
const t0 = Date.now();
const proc = spawnSync(cmd, args, { encoding: "utf8", timeout: common.timeoutMs + 30_000, env: { ...process.env, PYTHONUNBUFFERED: "1" } });
let result = null;
const lastLine = (proc.stdout ?? "").trim().split("\n").filter(Boolean).pop();
try {
  result = lastLine ? JSON.parse(lastLine) : null;
} catch {
  result = null;
}
const stderrTail = (proc.stderr ?? "").slice(-1500);
let cell;
if (!result) {
  const cause = proc.error?.message ?? (proc.status === null ? "python did not produce a result" : `python exited ${proc.status}`);
  const code = proc.error?.code === "ENOENT" ? "PYTHON_NOT_FOUND" : "PROBE_FAILED";
  cell = baseCell(id, "compat", code === "PYTHON_NOT_FOUND" ? "skip" : "fail", `${code}: ${cause.slice(0, 80)}`, {
    durationMs: Date.now() - t0,
    detail: { client: "py-sdk", slot, version: mcpVersion ?? "unknown", stderrTail },
    error: { code, cause: `${cause}\n${stderrTail}`.slice(0, 500), fix: code === "PYTHON_NOT_FOUND" ? "Install uv (astral-sh/setup-uv) or pass --python <venv>/bin/python" : undefined, retryable: false },
  });
} else {
  const version = result.sdkVersion ?? mcpVersion ?? "unknown";
  if (!result.ok && /401|unauthorized/i.test(String(result.error?.cause ?? ""))) result.error = { code: "AUTH_REQUIRED", cause: result.error?.cause ?? "401", fix: "Add an Authorization header or OAuth refresh credentials to the enrollment." };
  cell = baseCell(id, "compat", result.ok ? "pass" : result.error?.code === "AUTH_REQUIRED" ? "skip" : "fail", result.ok ? `${result.toolCount} tools via mcp ${version}` : `${result.error?.code}: ${String(result.error?.cause ?? "").slice(0, 80)}`, {
    durationMs: result.durationMs ?? Date.now() - t0,
    detail: { client: "py-sdk", slot, version, toolCount: result.toolCount ?? 0, protocolVersion: result.protocolVersion ?? null, stderrTail: result.ok ? "" : stderrTail },
    ...(result.ok ? {} : { error: { ...result.error, retryable: result.error?.code === "TIMEOUT" } }),
  });
}
await emit(cell, common);
process.exit(cell.status === "pass" ? 0 : 1);
