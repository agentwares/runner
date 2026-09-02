/**
 * Connect to an MCP server from a spec ("npx -y @org/server [args]", "uvx pkg",
 * any "<cmd> [args]") or a Streamable HTTP URL, with either the current SDK
 * (N) or the previous minor (N-1, installed as the `mcp-sdk-prev` alias).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseSpec(spec) {
  const tokens = spec.match(/(?:[^\s"]+|"[^"]*")+/g).map((t) => t.replace(/^"|"$/g, ""));
  let [command, ...args] = tokens;
  if (process.platform === "win32" && ["npx", "npm", "uvx", "pnpm", "node"].includes(command)) {
    command = command === "node" ? command : `${command}.cmd`;
  }
  return { command, args };
}

export async function loadSdk(slot = "N") {
  const base = slot === "N-1" ? "mcp-sdk-prev" : "@modelcontextprotocol/sdk";
  const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }] = await Promise.all([
    import(`${base}/client/index.js`),
    import(`${base}/client/stdio.js`),
    import(`${base}/client/streamableHttp.js`),
  ]);
  return { Client, StdioClientTransport, StreamableHTTPClientTransport, version: sdkVersion(base) };
}

/** Read node_modules/<base>/package.json directly: the SDK's exports map does not expose it. */
export function sdkVersion(base) {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", base, "package.json");
    return JSON.parse(readFileSync(file, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * @returns {{ client, close, stderr: () => string, serverVersion, protocolVersion, sdkVersion }}
 */
export async function connect({ spec, url, headers = {}, slot = "N", timeoutMs = 90000, clientName = "agentwares-runner" }) {
  const sdk = await loadSdk(slot);
  let transport;
  let stderr = "";
  if (url) {
    transport = new sdk.StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  } else {
    const { command, args } = parseSpec(spec);
    transport = new sdk.StdioClientTransport({ command, args, stderr: "pipe" });
    transport.stderr?.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
  }
  const client = new sdk.Client({ name: clientName, version: "0.1.0" });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT: no initialize within ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([client.connect(transport), deadline]);
  } finally {
    clearTimeout(timer);
  }
  const sv = client.getServerVersion?.();
  return {
    client,
    sdkVersion: sdk.version,
    serverVersion: sv ? { name: sv.name, version: sv.version } : null,
    protocolVersion: transport.protocolVersion ?? null,
    stderr: () => stderr,
    async close() {
      try {
        await client.close();
      } catch {
        /* already closed */
      }
    },
  };
}

export async function listAllTools(client) {
  const tools = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const res = await client.listTools(cursor ? { cursor } : {});
    tools.push(...res.tools);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return tools;
}

export function classifyError(e) {
  const msg = e instanceof Error ? e.message : String(e);
  const code = /ENOENT/.test(msg)
    ? "SPAWN_ENOENT"
    : /TIMEOUT|timed out|timeout/i.test(msg)
      ? "TIMEOUT"
      : /401|unauthorized|invalid_token|invalid access token/i.test(msg)
        ? "AUTH_REQUIRED"
        : /404|405/.test(msg)
          ? "NOT_MCP_ENDPOINT"
          : "CONNECT_FAILED";
  const fix = {
    SPAWN_ENOENT:
      process.platform === "win32"
        ? "The launcher was not found: on Windows npx/uvx must be invoked as npx.cmd/uvx.cmd (or ship a real binary). Clients like Claude Desktop hit the same ENOENT."
        : "The launcher was not found on PATH. Check the package spec and that npm/uv is installed.",
    TIMEOUT: "The server did not answer initialize in time; make sure it starts without prompts, network setup or missing env vars.",
    AUTH_REQUIRED: "Add an Authorization header or OAuth refresh credentials to the enrollment.",
    NOT_MCP_ENDPOINT: "Point at the Streamable HTTP endpoint (usually /mcp).",
    CONNECT_FAILED: "See stderr below.",
  }[code];
  return { code, cause: msg.slice(0, 500), fix, retryable: code === "TIMEOUT" || code === "CONNECT_FAILED" };
}

/** True when an unauthenticated initialize is refused (401/403): cells that cannot authenticate should skip. */
export async function needsAuth(url, headers = {}) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mcpcheck", version: "0.1.0" } } }),
      signal: AbortSignal.timeout(15000),
    });
    return res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}
