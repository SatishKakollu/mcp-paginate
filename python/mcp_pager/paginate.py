from __future__ import annotations
import json
from typing import Any, Callable

from mcp.server.fastmcp import FastMCP
from mcp.types import TextContent

from .chunk_store import ChunkStore
from .tokenize import default_token_counter
from .types import (
    ChunkedEvent,
    CursorExpiredEvent,
    PageFetchedEvent,
    PaginateEvent,
    PaginateOptions,
    StoreBackend,
)


def paginate(
    mcp: FastMCP,
    *,
    max_tokens: int = 4000,
    ttl_ms: int = 10 * 60 * 1000,
    token_counter: Callable[[str], int] | None = None,
    page_tool_name: str = "get_next_page",
    store: StoreBackend | None = None,
    signing_secret: str | None = None,
    on_paginate: Callable[[PaginateEvent], None] | None = None,
) -> FastMCP:
    """
    Wrap a FastMCP server with token-aware response paging.

    Call once before registering tools. Every tool response that exceeds
    max_tokens is automatically chunked and delivered page by page with
    agent-readable metadata.

    Example:
        mcp = FastMCP("my-server")
        paginate(mcp, max_tokens=4000)

        @mcp.tool()
        async def list_records(limit: int = 500) -> str:
            ...  # large response — automatically paged
    """
    counter = token_counter or default_token_counter
    chunk_store = ChunkStore(ttl_ms, store, signing_secret)

    # Register get_next_page BEFORE patching call_tool so it is never
    # re-paginated by the wrapper.
    @mcp.tool(name=page_tool_name, description="Retrieve the next page of a paginated tool response.")
    async def _get_next_page(cursor: str) -> list[TextContent]:
        result = await chunk_store.get(cursor)
        if result is None:
            _emit(on_paginate, CursorExpiredEvent())
            return [TextContent(
                type="text",
                text="Cursor not found or expired. Please re-invoke the original tool.",
            )]
        _emit(on_paginate, PageFetchedEvent(
            page_index=result["page_index"],
            total_pages=result["total_pages"],
            has_more=result["next_cursor"] is not None,
        ))
        return _build_page_response(
            result["chunk"], result["next_cursor"],
            page_tool_name, result["page_index"], result["total_pages"],
        )

    # Patch ToolManager.call_tool AFTER registering get_next_page.
    original_call_tool = mcp._tool_manager.call_tool

    async def _patched_call_tool(name: str, arguments: dict, context=None, convert_result: bool = False) -> Any:
        result = await original_call_tool(name, arguments, context, convert_result)
        if name == page_tool_name:
            return result
        return await _maybe_paginate(
            result, chunk_store, max_tokens, counter,
            page_tool_name, name, on_paginate,
        )

    mcp._tool_manager.call_tool = _patched_call_tool  # type: ignore[method-assign]

    return mcp


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _maybe_paginate(
    result: Any,
    store: ChunkStore,
    max_tokens: int,
    counter: Callable[[str], int],
    page_tool_name: str,
    tool_name: str,
    on_paginate: Callable[[PaginateEvent], None] | None,
) -> Any:
    full_text = _content_to_text(result)
    total_tokens = counter(full_text)

    if total_tokens <= max_tokens:
        return result

    chunks = _split_into_chunks(full_text, max_tokens, counter)
    id = await store.save(chunks)

    _emit(on_paginate, ChunkedEvent(
        tool_name=tool_name,
        total_tokens=total_tokens,
        total_chunks=len(chunks),
    ))

    total_pages = len(chunks)
    next_cursor = store.create_cursor(id, 1) if total_pages > 1 else None
    return _build_page_response(chunks[0], next_cursor, page_tool_name, 0, total_pages)


def _build_page_response(
    chunk: str,
    next_cursor: str | None,
    page_tool_name: str,
    page_index: int,
    total_pages: int,
) -> list[TextContent]:
    meta: dict = {
        "hasMore": next_cursor is not None,
        "pageIndex": page_index,
        "totalPages": total_pages,
        "remainingPages": total_pages - page_index - 1,
    }
    if next_cursor:
        meta["nextCursor"] = next_cursor
        meta["instruction"] = (
            f"Call `{page_tool_name}` with nextCursor to get the next page. "
            "Repeat until hasMore is false."
        )
    else:
        meta["instruction"] = "All pages have been retrieved."

    return [
        TextContent(type="text", text=chunk),
        TextContent(type="text", text=f"\n---\n```json\n{json.dumps(meta, indent=2)}\n```"),
    ]


def _split_into_chunks(text: str, max_tokens: int, counter: Callable[[str], int]) -> list[str]:
    chunks: list[str] = []
    start = 0
    while start < len(text):
        lo, hi = 1, len(text) - start
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if counter(text[start:start + mid]) <= max_tokens:
                lo = mid
            else:
                hi = mid - 1
        chunks.append(text[start:start + lo])
        start += lo
    return chunks


def _content_to_text(result: Any) -> str:
    if isinstance(result, str):
        return result
    if isinstance(result, list):
        parts = []
        for item in result:
            if hasattr(item, "text"):
                parts.append(item.text)
            elif isinstance(item, str):
                parts.append(item)
            else:
                parts.append(json.dumps(item, default=str))
        return "\n".join(parts)
    return json.dumps(result, default=str)


def _emit(
    on_paginate: Callable[[PaginateEvent], None] | None,
    event: PaginateEvent,
) -> None:
    if on_paginate is None:
        return
    try:
        on_paginate(event)
    except Exception:
        pass  # never crash the pagination pipeline
