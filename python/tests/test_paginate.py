import json
import pytest
from mcp.server.fastmcp import FastMCP
from mcp.types import TextContent

from mcp_pager import paginate, ChunkedEvent, PageFetchedEvent, CursorExpiredEvent, PaginateEvent


def make_large_text(tokens: int) -> str:
    return "x" * (tokens * 4)


def make_server() -> FastMCP:
    return FastMCP("test-server")


def parse_meta(content: list[TextContent]) -> dict:
    last = content[-1].text
    import re
    match = re.search(r"```json\s*([\s\S]+?)\s*```", last)
    assert match, f"No JSON meta block in: {last}"
    return json.loads(match.group(1))


def extract_cursor(content: list[TextContent]) -> str | None:
    last = content[-1].text
    import re
    m = re.search(r'"nextCursor":\s*"([^"]+)"', last)
    return m.group(1) if m else None


# ─── Basic pagination ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_small_response_unchanged():
    mcp = make_server()
    paginate(mcp, max_tokens=100)

    @mcp.tool()
    async def echo(msg: str) -> str:
        return msg

    result = await mcp._tool_manager.call_tool("echo", {"msg": "hello"})
    # Small responses are returned as list[TextContent] (consistent format).
    assert isinstance(result, list)
    assert result[0].text == "hello"


@pytest.mark.asyncio
async def test_large_response_chunked():
    mcp = make_server()
    paginate(mcp, max_tokens=50)

    @mcp.tool()
    async def big() -> str:
        return make_large_text(200)

    result = await mcp._tool_manager.call_tool("big", {})
    assert isinstance(result, list)
    meta = parse_meta(result)
    assert meta["hasMore"] is True
    assert meta["pageIndex"] == 0
    assert meta["totalPages"] > 1
    assert "nextCursor" in meta
    assert "get_next_page" in meta["instruction"]


@pytest.mark.asyncio
async def test_last_page_has_more_false():
    mcp = make_server()
    paginate(mcp, max_tokens=50)

    @mcp.tool()
    async def big() -> str:
        return make_large_text(200)

    result = await mcp._tool_manager.call_tool("big", {})
    pages = 1
    while True:
        meta = parse_meta(result)
        if not meta["hasMore"]:
            assert meta["remainingPages"] == 0
            assert "All pages" in meta["instruction"]
            break
        result = await mcp._tool_manager.call_tool(
            "get_next_page", {"cursor": meta["nextCursor"]}
        )
        pages += 1
        assert pages < 50, "Infinite loop"


@pytest.mark.asyncio
async def test_full_reassembly():
    mcp = make_server()
    paginate(mcp, max_tokens=50)
    original = make_large_text(200)

    @mcp.tool()
    async def big() -> str:
        return original

    result = await mcp._tool_manager.call_tool("big", {})
    parts = [result[0].text]
    while True:
        meta = parse_meta(result)
        if not meta["hasMore"]:
            break
        result = await mcp._tool_manager.call_tool(
            "get_next_page", {"cursor": meta["nextCursor"]}
        )
        parts.append(result[0].text)

    assert "".join(parts) == original


@pytest.mark.asyncio
async def test_invalid_cursor_returns_error():
    mcp = make_server()
    paginate(mcp, max_tokens=50)
    result = await mcp._tool_manager.call_tool("get_next_page", {"cursor": "invalid"})
    assert isinstance(result, list)
    assert "expired" in result[0].text.lower() or "not found" in result[0].text.lower()


# ─── onPaginate events ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_chunked_event_fired():
    events: list[PaginateEvent] = []
    mcp = make_server()
    paginate(mcp, max_tokens=50, on_paginate=events.append)

    @mcp.tool()
    async def big() -> str:
        return make_large_text(200)

    await mcp._tool_manager.call_tool("big", {})
    chunked = next((e for e in events if e.type == "chunked"), None)
    assert chunked is not None
    assert chunked.tool_name == "big"
    assert chunked.total_chunks > 1


@pytest.mark.asyncio
async def test_page_fetched_event_fired():
    events: list[PaginateEvent] = []
    mcp = make_server()
    paginate(mcp, max_tokens=50, on_paginate=events.append)

    @mcp.tool()
    async def big() -> str:
        return make_large_text(200)

    result = await mcp._tool_manager.call_tool("big", {})
    meta = parse_meta(result)
    await mcp._tool_manager.call_tool("get_next_page", {"cursor": meta["nextCursor"]})

    fetched = next((e for e in events if e.type == "page_fetched"), None)
    assert fetched is not None
    assert fetched.page_index == 1


@pytest.mark.asyncio
async def test_cursor_expired_event_fired():
    events: list[PaginateEvent] = []
    mcp = make_server()
    paginate(mcp, max_tokens=50, on_paginate=events.append)
    await mcp._tool_manager.call_tool("get_next_page", {"cursor": "bad"})
    assert any(e.type == "cursor_expired" for e in events)


@pytest.mark.asyncio
async def test_on_paginate_crash_does_not_break_pipeline():
    def bad_callback(e):
        raise RuntimeError("logger crashed")

    mcp = make_server()
    paginate(mcp, max_tokens=50, on_paginate=bad_callback)

    @mcp.tool()
    async def big() -> str:
        return make_large_text(200)

    result = await mcp._tool_manager.call_tool("big", {})
    assert result is not None


# ─── HMAC signing ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_signing_end_to_end():
    mcp = make_server()
    paginate(mcp, max_tokens=50, signing_secret="my-secret")
    original = make_large_text(200)

    @mcp.tool()
    async def big() -> str:
        return original

    result = await mcp._tool_manager.call_tool("big", {})
    parts = [result[0].text]
    pages = 1
    while True:
        meta = parse_meta(result)
        if not meta["hasMore"]:
            break
        result = await mcp._tool_manager.call_tool(
            "get_next_page", {"cursor": meta["nextCursor"]}
        )
        parts.append(result[0].text)
        pages += 1
        assert pages < 50

    assert "".join(parts) == original


@pytest.mark.asyncio
async def test_tampered_cursor_rejected():
    mcp = make_server()
    paginate(mcp, max_tokens=50, signing_secret="my-secret")

    @mcp.tool()
    async def big() -> str:
        return make_large_text(200)

    result = await mcp._tool_manager.call_tool("big", {})
    meta = parse_meta(result)
    tampered = meta["nextCursor"][:-4] + "XXXX"
    result2 = await mcp._tool_manager.call_tool("get_next_page", {"cursor": tampered})
    assert "expired" in result2[0].text.lower() or "not found" in result2[0].text.lower()


# ─── Custom pageToolName ──────────────────────────────────────────────────────

# ─── Smart chunking ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_json_array_chunks_are_valid_json():
    mcp = make_server()
    paginate(mcp, max_tokens=100)

    records = [{"id": i, "name": f"Employee {i}", "dept": "Engineering"} for i in range(50)]

    @mcp.tool()
    async def list_records() -> str:
        return json.dumps(records, indent=2)

    result = await mcp._tool_manager.call_tool("list_records", {})
    pages = 0
    while True:
        chunk = result[0].text
        parsed = json.loads(chunk)  # must not raise
        assert isinstance(parsed, list)
        pages += 1
        meta = parse_meta(result)
        if not meta["hasMore"]:
            break
        result = await mcp._tool_manager.call_tool(
            "get_next_page", {"cursor": meta["nextCursor"]}
        )
        assert pages < 50, "Infinite loop"
    assert pages > 1


@pytest.mark.asyncio
async def test_json_array_no_records_lost():
    mcp = make_server()
    paginate(mcp, max_tokens=100)

    records = [{"id": i} for i in range(30)]

    @mcp.tool()
    async def list_records() -> str:
        return json.dumps(records)

    result = await mcp._tool_manager.call_tool("list_records", {})
    all_ids = []
    while True:
        all_ids.extend(r["id"] for r in json.loads(result[0].text))
        meta = parse_meta(result)
        if not meta["hasMore"]:
            break
        result = await mcp._tool_manager.call_tool(
            "get_next_page", {"cursor": meta["nextCursor"]}
        )
    assert sorted(all_ids) == [r["id"] for r in records]


@pytest.mark.asyncio
async def test_log_lines_split_at_boundaries():
    mcp = make_server()
    paginate(mcp, max_tokens=50)

    logs = "\n".join(
        f"2026-06-02T{i:06d}Z INFO service processed request {i}"
        for i in range(100)
    )

    @mcp.tool()
    async def fetch_logs() -> str:
        return logs

    result = await mcp._tool_manager.call_tool("fetch_logs", {})
    parts = []
    while True:
        parts.append(result[0].text)
        meta = parse_meta(result)
        if not meta["hasMore"]:
            break
        result = await mcp._tool_manager.call_tool(
            "get_next_page", {"cursor": meta["nextCursor"]}
        )

    # Every non-empty line in every chunk must exist verbatim in original
    for part in parts:
        for line in part.split("\n"):
            if line.strip():
                assert line in logs


# ─── Custom pageToolName ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_custom_page_tool_name():
    mcp = make_server()
    paginate(mcp, max_tokens=50, page_tool_name="next_chunk")

    @mcp.tool()
    async def big() -> str:
        return make_large_text(200)

    result = await mcp._tool_manager.call_tool("big", {})
    meta = parse_meta(result)
    assert "next_chunk" in meta["instruction"]
    tools = mcp._tool_manager.list_tools()
    names = [t.name for t in tools]
    assert "next_chunk" in names
    assert "get_next_page" not in names
