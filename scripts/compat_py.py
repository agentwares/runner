#!/usr/bin/env python3
"""Client-compat probe with the official Python SDK (`mcp`): connect over stdio or
Streamable HTTP, initialize, list tools, print one JSON line. Works with mcp 1.x and 2.x.

  python scripts/compat_py.py --spec "npx -y @org/server" | --url https://host/mcp [--headers-json '{}'] [--timeout 90]
"""
import argparse
import asyncio
import json
import os
import shlex
import sys
import time


def parse_spec(spec: str):
    tokens = shlex.split(spec, posix=os.name != "nt")
    command, args = tokens[0], tokens[1:]
    if os.name == "nt" and command in ("npx", "npm", "uvx", "pnpm"):
        command = f"{command}.cmd"
    return command, args


async def run(args):
    import mcp  # noqa: F401
    from mcp import ClientSession

    version = getattr(mcp, "__version__", None)
    if not version:
        try:
            from importlib.metadata import version as _v

            version = _v("mcp")
        except Exception:  # pragma: no cover
            version = "unknown"

    headers = json.loads(args.headers_json) if args.headers_json else {}
    t0 = time.time()
    if args.url:
        from mcp.client.streamable_http import streamablehttp_client

        ctx = streamablehttp_client(args.url, headers=headers or None)
    else:
        from mcp.client.stdio import StdioServerParameters, stdio_client

        command, cmd_args = parse_spec(args.spec)
        ctx = stdio_client(StdioServerParameters(command=command, args=cmd_args, env=dict(os.environ)))

    async with ctx as streams:
        read, write = streams[0], streams[1]
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            tools = []
            cursor = None
            for _ in range(20):
                res = await session.list_tools(cursor=cursor) if cursor else await session.list_tools()
                tools.extend(res.tools)
                cursor = getattr(res, "nextCursor", None)
                if not cursor:
                    break
            server = getattr(init, "serverInfo", None)
            return {
                "ok": len(tools) > 0,
                "sdkVersion": version,
                "toolCount": len(tools),
                "tools": [t.name for t in tools][:200],
                "server": {"name": server.name, "version": server.version} if server else None,
                "protocolVersion": getattr(init, "protocolVersion", None),
                "durationMs": int((time.time() - t0) * 1000),
            }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--spec")
    p.add_argument("--url")
    p.add_argument("--headers-json")
    p.add_argument("--timeout", type=float, default=90)
    args = p.parse_args()
    if not args.spec and not args.url:
        p.error("--spec or --url required")
    try:
        result = asyncio.run(asyncio.wait_for(run(args), timeout=args.timeout))
    except asyncio.TimeoutError:
        result = {"ok": False, "error": {"code": "TIMEOUT", "cause": f"no initialize within {args.timeout}s"}}
    except FileNotFoundError as e:
        result = {"ok": False, "error": {"code": "SPAWN_ENOENT", "cause": str(e)[:500]}}
    except BaseException as e:  # noqa: BLE001 — anyio ExceptionGroups included
        result = {"ok": False, "error": {"code": "CONNECT_FAILED", "cause": f"{type(e).__name__}: {str(e)[:500]}"}}
    try:
        import mcp
        from importlib.metadata import version as _v

        result.setdefault("sdkVersion", getattr(mcp, "__version__", None) or _v("mcp"))
    except Exception:
        pass
    print(json.dumps(result))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
