"""
mcp-pager Python demo server.

Run:
    python examples/demo_server.py

Then connect any MCP client and call list_records, list_files, or fetch_logs.
Each tool returns large payloads that mcp-pager automatically pages.
"""
import asyncio
import json
import random
import string
from datetime import datetime, timedelta

from mcp.server.fastmcp import FastMCP

from mcp_pager import paginate

mcp = FastMCP("mcp-pager-demo")

# One line — every tool below is now token-safe.
paginate(mcp, max_tokens=4000, ttl_ms=10 * 60 * 1000)


@mcp.tool(description="List employee records from the HR database")
async def list_records(limit: int = 500) -> str:
    departments = ["Engineering", "Sales", "Marketing", "HR", "Finance"]
    records = [
        {
            "id": i + 1,
            "name": f"Employee {i + 1}",
            "email": f"employee{i + 1}@company.example",
            "department": departments[i % len(departments)],
            "salary": 60_000 + (i % 50) * 1_000,
            "start_date": (datetime.now() - timedelta(days=i * 30)).date().isoformat(),
        }
        for i in range(min(limit, 2000))
    ]
    return json.dumps(records, indent=2)


@mcp.tool(description="Recursively list files under a path")
async def list_files(path: str, depth: int = 3) -> str:
    count = min(8 ** depth, 512)
    entries = [
        {
            "path": f"{path}/subdir-{i // 8}/file-{i}.py",
            "type": "file",
            "size_bytes": 1024 + (i * 137) % 102400,
            "modified": (datetime.now() - timedelta(hours=i)).isoformat(),
        }
        for i in range(count)
    ]
    return json.dumps(entries, indent=2)


@mcp.tool(description="Fetch recent application logs for a service")
async def fetch_logs(service: str, lines: int = 500, level: str = "ALL") -> str:
    levels = ["INFO", "WARN", "ERROR", "DEBUG"]
    logs = [
        {
            "timestamp": (datetime.now() - timedelta(seconds=i)).isoformat(),
            "level": levels[i % 4],
            "service": service,
            "trace_id": "".join(random.choices(string.hexdigits, k=16)),
            "message": f"[{service}] Request {i + 1} processed in {10 + i % 200}ms — status {500 if i % 20 == 0 else 200}",
        }
        for i in range(min(lines, 5000))
        if level == "ALL" or levels[i % 4] == level
    ]
    return json.dumps(logs, indent=2)


if __name__ == "__main__":
    mcp.run()
