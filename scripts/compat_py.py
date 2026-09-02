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


def describe(exc, depth=0):
    """Flatten anyio/TaskGroup ExceptionGroups so the real cause (e.g. a 401)
    reaches the cell instead of 'unhandled errors in a TaskGroup'."""
    label = f"{type(exc).__name__}: {exc}".strip().rstrip(":")
    subs = getattr(exc, "exceptions", None)
    if subs and depth < 4:
        inner = "; ".join(describe(s, depth + 1) for s in subs[:4])
        return f"{label} [{inner}]" if inner else label
    cause = getattr(exc, "__cause__", None) or getattr(exc, "__context__", None)
    if cause is not None and depth < 4:
        return f"{label} (caused by {describe(cause, depth + 1)})"
    return label


def attr(obj, *names):
    """First present attribute — mcp 2.x is snake_case, 1.x was camelCase."""
    for n in names:
        v = getattr(obj, n, None)
        if v is not None:
            return v
    return None


async def list_tools_page(session, cursor):
    """tools/list one page. mcp 2.x takes params=PaginatedRequestParams, 1.x took cursor=."""
    if not cursor:
        return await session.list_tools()
    try:
        from mcp import types as mcp_types

        return await session.list_tools(params=mcp_types.PaginatedRequestParams(cursor=cursor))
    except TypeError:
        return await session.list_tools(cursor=cursor)


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
        import mcp.client.streamable_http as sh

        if hasattr(sh, "streamable_http_client"):
            # mcp 2.x renamed the factory and moved headers onto the http client.
            if headers:
                import httpx2

                ctx = sh.streamable_http_client(
                    args.url, http_client=httpx2.AsyncClient(headers=headers)
                )
            else:
                ctx = sh.streamable_http_client(args.url)
        else:
            # mcp 1.x
            ctx = sh.streamablehttp_client(args.url, headers=headers or None)
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
                res = await list_tools_page(session, cursor)
                tools.extend(res.tools)
                # mcp 1.x: nextCursor; mcp 2.x: next_cursor
                cursor = attr(res, "next_cursor", "nextCursor")
                if not cursor:
                    break
            server = attr(init, "server_info", "serverInfo")
            return {
                "ok": len(tools) > 0,
                "sdkVersion": version,
                "toolCount": len(tools),
                "tools": [t.name for t in tools][:200],
                "server": {"name": server.name, "version": server.version} if server else None,
                "protocolVersion": attr(init, "protocol_version", "protocolVersion"),
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
        result = {"ok": False, "error": {"code": "CONNECT_FAILED", "cause": describe(e)[:500]}}
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
