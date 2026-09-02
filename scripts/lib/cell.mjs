/**
 * Cell helpers: host id, write to disk, signed POST to agentcheck.
 * Payload contract: { kind: "mcp_check_cell", targetId, runKey, workflowRunId, cell }
 * signed with HMAC-SHA256 over the raw body → X-Agentwares-Signature: sha256=<hex>.
 */
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

export function flag(name) {
  return process.argv.includes(`--${name}`);
}

/** `ubuntu-latest` etc. in Actions (MCPCHECK_HOST from the matrix), `local-<platform>` elsewhere. */
export function hostId() {
  return process.env.MCPCHECK_HOST || `local-${process.platform}`;
}

export function sourceId() {
  return process.env.GITHUB_ACTIONS ? "runner" : "local";
}

export function baseCell(id, kind, status, summary, extra = {}) {
  return {
    id,
    kind,
    status,
    host: hostId(),
    source: sourceId(),
    ranAt: new Date().toISOString(),
    summary,
    ...extra,
  };
}

export function writeCell(outDir, cell) {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${cell.id.replace(/[^a-zA-Z0-9@.-]+/g, "_")}.json`);
  writeFileSync(file, JSON.stringify(cell, null, 2));
  return file;
}

/** Fetch the signed job manifest (auth headers, refreshed token) — never printed. */
export async function fetchJob(jobUrl, secret) {
  if (!jobUrl) return null;
  const sig = createHmac("sha256", secret ?? "").update(new URL(jobUrl).pathname).digest("hex");
  const res = await fetch(jobUrl, { headers: { "x-agentwares-signature": `sha256=${sig}` } });
  if (!res.ok) {
    console.log(`job manifest ${res.status} (continuing without it)`);
    return null;
  }
  return res.json();
}

export async function postCell({ url, secret, targetId, runKey, cell }) {
  if (!url) return { skipped: true };
  const body = JSON.stringify({
    kind: "mcp_check_cell",
    targetId,
    runKey,
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    cell,
  });
  const sig = createHmac("sha256", secret ?? "").update(body).digest("hex");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentwares-signature": `sha256=${sig}` },
    body,
  });
  const text = await res.text();
  console.log(`callback ${res.status} for ${cell.id}${res.ok ? "" : `: ${text.slice(0, 200)}`}`);
  return { ok: res.ok, status: res.status };
}

/** Standard tail for every cell script: write, optionally post, print one line. */
export async function emit(cell, { outDir, callbackUrl, secret, targetId, runKey }) {
  const file = writeCell(outDir, cell);
  await postCell({ url: callbackUrl, secret, targetId, runKey, cell });
  console.log(JSON.stringify({ cell: cell.id, status: cell.status, summary: cell.summary, file }));
  return cell;
}

export function commonArgs() {
  return {
    outDir: arg("out", "out"),
    callbackUrl: arg("callback", process.env.CALLBACK_URL || ""),
    secret: process.env.AGENTCHECK_CALLBACK_SECRET ?? "",
    targetId: arg("target-id", "local"),
    runKey: arg("run-key", `local:${new Date().toISOString().slice(0, 10)}`),
    jobUrl: arg("job-url", process.env.JOB_URL || ""),
    timeoutMs: Number(arg("timeout", "90000")),
  };
}

export function textOf(result) {
  const parts = [];
  if (Array.isArray(result?.content)) {
    for (const c of result.content) {
      if (typeof c?.text === "string") parts.push(c.text);
      else if (c?.type) parts.push(`[${c.type}]`);
    }
  }
  if (!parts.length && result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\n");
}

export function truncate(s, n = 600) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
