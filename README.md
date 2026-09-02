# agentwares/runner

Public GitHub Actions runner for **mcpcheck** (nightly checks for MCP publishers, part of agentcheck). Public repo = free matrix minutes. Owned by brief P1-B; never runs private matrix jobs.

## What it does

`mcp-check.yml` is dispatched by agentcheck's tick (`workflow_dispatch`) for one enrolled server and runs, on **ubuntu / macos / windows**:

| cell                                   | script                                | what                                                                                                                   |
| -------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `install:<os>` + `catalog:<os>`        | `scripts/probe.mjs`                   | clean-cache install of the package spec (or connect to the URL), `initialize`, full `tools/list` with schemas         |
| `errors:<os>` (ubuntu)                 | `scripts/errors.mjs`                  | 10 malformed inputs per tool (generator vendored from `packages/mcp-checks`), raw responses; graded in agentcheck      |
| `compat:ts-sdk@N / N-1:<os>`           | `scripts/compat-ts.mjs`               | official TypeScript SDK client, current and previous minor (`mcp-sdk-prev` alias)                                      |
| `compat:py-sdk@N / N-1:<os>`           | `scripts/compat-py.mjs` + `compat_py.py` | official Python SDK client via `uv run --with mcp==<ver>` (or `--python <venv>` locally)                            |
| `compat:claude-cli@cli:<os>` (ubuntu)  | `scripts/compat-claude.mjs`           | scripted `claude -p --mcp-config … --strict-mcp-config`; needs `ANTHROPIC_API_KEY` secret (API billing)                |
| `conformance:<os>` (ubuntu, remote)    | `scripts/conformance.mjs`             | generic `@modelcontextprotocol/conformance server` scenarios                                                           |

OAuth conformance runs in agentcheck's tick (no machine needed) — see `packages/mcp-checks/src/oauth.ts`.

Each cell is written to `out/<cell>.json`, uploaded as an artifact, and POSTed to `callback_url` as soon as it finishes:

```json
{ "kind": "mcp_check_cell", "targetId": "…", "runKey": "…", "workflowRunId": "…", "cell": { "id": "install:windows-latest", "kind": "install", "status": "fail", "host": "windows-latest", "source": "runner", "ranAt": "…", "summary": "SPAWN_ENOENT: spawn npx ENOENT", "detail": { … }, "error": { "code": "SPAWN_ENOENT", "cause": "…", "fix": "…", "retryable": false } } }
```

signed with `X-Agentwares-Signature: sha256=<HMAC-SHA256 of the raw body>` using the repository secret `AGENTCHECK_CALLBACK_SECRET` (same value as agentcheck's env var). Workflow inputs are visible on a public repo, so they never carry secrets: auth headers / a refreshed access token come from the signed job manifest (`job_url`, `GET /api/runner/jobs/<runKey>`), fetched at run time and never printed.

## Dispatch

```bash
gh workflow run mcp-check.yml \
  -f package_spec="npx -y @modelcontextprotocol/server-everything" \
  -f target_id="tgt_123" -f run_key="tgt_123:2026-09-02" \
  -f callback_url="https://agentwares-agentcheck.vercel.app/api/runner/callback" \
  -f cells="install,catalog,errors,compat"
```

`mcp-clean-install.yml` is the Wave-0 single-cell workflow (kept for compatibility; its legacy payload is also accepted by the callback).

## Run locally (same scripts, one OS)

```bash
npm ci
node scripts/run-local.mjs --spec "npx -y @modelcontextprotocol/server-everything" --slug everything \
  --python-n ~/venvs/mcp-n/bin/python --python-prev ~/venvs/mcp-prev/bin/python
node scripts/run-local.mjs --url https://mcp.deepwiki.com/mcp --slug deepwiki
```

Cells land in `out/<slug>/`. Add `--callback https://…/api/runner/callback --target-id … --run-key …` (with `AGENTCHECK_CALLBACK_SECRET` in the env) to post them. `packages/mcp-checks/scripts/import-fixtures.mjs` turns an `out/` directory into the demo corpus.

## Versions

- TypeScript SDK N = `@modelcontextprotocol/sdk` in `package.json`; N-1 = the `mcp-sdk-prev` alias. Bump both on SDK releases.
- Python SDK N / N-1 = `MCP_PY_N` / `MCP_PY_PREV` in the workflow.
- `scripts/lib/malformed.mjs` is generated from `packages/mcp-checks/src/malformed.ts` (`pnpm --filter @agentwares/mcp-checks sync:runner`); do not edit by hand.
