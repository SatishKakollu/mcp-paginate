"""
Edge case test server for Claude Desktop — Python version.
Each tool exercises a specific edge case.

Run: python examples/edge_case_server.py
"""
import json
import math
import random
from datetime import datetime, timedelta

from mcp.server.fastmcp import FastMCP
from mcp_pager import paginate, ChunkedEvent, PageFetchedEvent, CursorExpiredEvent

mcp = FastMCP("edge-case-server-python")

def log(msg: str):
    import sys
    print(f"[PAGINATE-PY] {msg}", file=sys.stderr)

def handle_event(event):
    if event.type == "chunked":
        log(f"chunked: {event.tool_name} → {event.total_chunks} pages ({event.total_tokens} tokens)")
    elif event.type == "page_fetched":
        log(f"page_fetched: {event.page_index + 1}/{event.total_pages} hasMore={event.has_more}")
    elif event.type == "cursor_expired":
        log("cursor_expired")

paginate(mcp,
    max_tokens=200,
    ttl_ms=30_000,
    signing_secret="test-secret-12345",
    on_paginate=handle_event,
)


# ─── EC-1: Small response — should pass through unchanged ────────────────────
@mcp.tool(description="EC-1: Returns a small response (under token limit). Should NOT paginate.")
async def ec_small_response() -> str:
    return json.dumps({"message": "This is small", "items": [1, 2, 3]})


# ─── EC-2: Large JSON array — record boundary split ───────────────────────────
@mcp.tool(description="EC-2: Large JSON array. Each page should be valid JSON with complete records.")
async def ec_json_array(count: int = 100) -> str:
    records = [
        {
            "id": i + 1,
            "name": f"Record {i + 1}",
            "description": f"Detailed description for record {i + 1} with extra text to make it larger",
            "tags": ["alpha", "beta", "gamma"],
            "score": random.random(),
        }
        for i in range(min(count, 200))
    ]
    return json.dumps(records, indent=2)


# ─── EC-3: Nested object (Pokémon-style) ─────────────────────────────────────
@mcp.tool(description="EC-3: Large nested object (not a bare array). Tests nested array splitting.")
async def ec_nested_object() -> str:
    data = {
        "id": 1,
        "name": "test-entity",
        "metadata": {"created": datetime.now().isoformat(), "version": "1.0"},
        "events": [
            {
                "id": i + 1,
                "type": ["click", "view", "purchase", "scroll"][i % 4],
                "timestamp": (datetime.now() - timedelta(minutes=i)).isoformat(),
                "payload": {"userId": f"user-{i % 10}", "value": random.random() * 100},
            }
            for i in range(80)
        ],
        "metrics": [
            {"name": f"metric-{i}", "value": random.random()}
            for i in range(20)
        ],
    }
    return json.dumps(data, indent=2)


# ─── EC-4: Log lines — line boundary split ────────────────────────────────────
@mcp.tool(description="EC-4: Log lines. Each page should contain complete log entries (no split mid-line).")
async def ec_log_lines(lines: int = 200) -> str:
    levels = ["INFO", "WARN", "ERROR", "DEBUG"]
    log_lines = [
        f"{(datetime.now() - timedelta(seconds=i)).isoformat()} [{levels[i % 4]}] "
        f"service-api Request {i + 1} completed in {10 + (i % 200)}ms "
        f"status={500 if i % 20 == 0 else 200} traceId=abc{i}"
        for i in range(min(lines, 500))
    ]
    return "\n".join(log_lines)


# ─── EC-5: Very large response (stress test) ─────────────────────────────────
@mcp.tool(description="EC-5: Very large response creating 50+ pages. Tests memory and loop stability.")
async def ec_stress_test() -> str:
    records = [
        {"id": i + 1, "data": f"item-{i}-" + "x" * 50}
        for i in range(500)
    ]
    return json.dumps(records, indent=2)


# ─── EC-6: Empty response ─────────────────────────────────────────────────────
@mcp.tool(description="EC-6: Returns an empty array. Should pass through with no pagination envelope.")
async def ec_empty() -> str:
    return "[]"


# ─── EC-7: Concurrent sessions ───────────────────────────────────────────────
@mcp.tool(description="EC-7a: Call this AND ec_session_b simultaneously to test session isolation.")
async def ec_session_a() -> str:
    return json.dumps([{"session": "A", "id": i} for i in range(60)], indent=2)


@mcp.tool(description="EC-7b: Call this AND ec_session_a simultaneously to test session isolation.")
async def ec_session_b() -> str:
    return json.dumps([{"session": "B", "id": i} for i in range(60)], indent=2)


# ─── EC-8: Mixed content ─────────────────────────────────────────────────────
@mcp.tool(description="EC-8: Mixed markdown + JSON + plain text in one response.")
async def ec_mixed_content() -> str:
    lines = [
        "# Report Title",
        f"Generated at: {datetime.now().isoformat()}",
        "",
        "## Summary",
        "- Total records: 100",
        "- Status: OK",
        "",
        "## Data",
        "```json",
        json.dumps([{"id": i, "val": f"v{i}"} for i in range(40)], indent=2),
        "```",
        "",
        "## Notes",
        *[f"Line {i + 1}: Some note about item {i + 1} with enough text to fill space"
          for i in range(50)],
    ]
    return "\n".join(lines)


if __name__ == "__main__":
    mcp.run()
