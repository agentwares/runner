#!/usr/bin/env node
/**
 * Sign a result file with HMAC-SHA256 and POST it to the callback URL.
 *   node scripts/post.mjs --file result.json --url https://... --target-id X --run-key Y --os ubuntu-latest
 * Secret from AGENTCHECK_CALLBACK_SECRET. Exits 0 even if the callback is missing (artifact still uploaded).
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const url = arg("url");
if (!url) {
  console.log("no callback url; skipping post");
  process.exit(0);
}
const secret = process.env.AGENTCHECK_CALLBACK_SECRET ?? "";
const result = JSON.parse(readFileSync(arg("file", "result.json"), "utf8"));
const payload = JSON.stringify({
  kind: "mcp_clean_install",
  targetId: arg("target-id"),
  runKey: arg("run-key"),
  runnerOs: arg("os"),
  workflowRunId: process.env.GITHUB_RUN_ID ?? null,
  result,
});
const sig = createHmac("sha256", secret).update(payload).digest("hex");
const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-agentwares-signature": `sha256=${sig}` },
  body: payload,
});
console.log(`callback ${res.status}`);
process.exit(res.ok ? 0 : 1);
