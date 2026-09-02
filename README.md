# agentwares/runner

Public GitHub Actions runner for **mcpcheck** (agentcheck's MCP publisher pack). Public repo = free matrix minutes.

`mcp-clean-install` is triggered by agentcheck via `workflow_dispatch`, installs an MCP server package from a clean cache on **ubuntu / macos / windows**, starts it over stdio, runs `initialize` + `tools/list`, and posts a signed JSON result back to agentcheck.

```bash
gh workflow run mcp-clean-install.yml \
  -f package_spec="npx -y @modelcontextprotocol/server-everything" \
  -f target_id="tgt_123" -f run_key="tgt_123:2026-09-02" \
  -f callback_url="https://agentcheck.vercel.app/api/runner/callback"
```

Results are also uploaded as workflow artifacts (`result-<os>.json`).

The callback is signed with `X-Agentwares-Signature: sha256=<hmac>` using the repository secret `AGENTCHECK_CALLBACK_SECRET`.

Owned by brief P1-B (`docs/handoff/briefs/P1-B.md` in the agentwares monorepo). Never runs private matrix jobs.
