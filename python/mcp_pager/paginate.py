from __future__ import annotations
import functools
import inspect
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

    # Register get_next_page BEFORE patching add_tool so it is never
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

    # Clear outputSchema on get_next_page itself (it returns list[TextContent]
    # which FastMCP still wraps in structured output in 1.27+).
    _clear_output_schema(mcp, page_tool_name)

    # Patch add_tool so every SUBSEQUENT registration gets:
    #   1. A paginating wrapper around the tool function
    #   2. outputSchema cleared (avoids FastMCP structured output validation)
    # add_tool signature: (fn, name=None, title=None, description=None, ...)
    original_add_tool = mcp._tool_manager.add_tool

    def _patched_add_tool(
        fn: Callable, name: str | None = None, **kwargs: Any
    ) -> Any:
        tool_name = name or fn.__name__
        if tool_name == page_tool_name:
            return original_add_tool(fn, name=name, **kwargs)

        is_async = inspect.iscoroutinefunction(fn)

        @functools.wraps(fn)
        async def _wrapped(**call_kwargs: Any) -> list[TextContent]:
            result = (await fn(**call_kwargs)) if is_async else fn(**call_kwargs)
            return await _maybe_paginate(
                result, chunk_store, max_tokens, counter,
                page_tool_name, tool_name, on_paginate,
            )

        registered = original_add_tool(_wrapped, name=name, **kwargs)

        # Clear structured outputSchema AFTER registration so the MCP client
        # won't validate our list[TextContent] responses against it.
        _clear_output_schema(mcp, tool_name)

        return registered

    mcp._tool_manager.add_tool = _patched_add_tool  # type: ignore[method-assign]

    return mcp


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _clear_output_schema(mcp: FastMCP, tool_name: str) -> None:
    """Suppress FastMCP's structured outputSchema for a tool."""
    tool = mcp._tool_manager._tools.get(tool_name)
    if tool and hasattr(tool, "fn_metadata") and tool.fn_metadata is not None:
        tool.fn_metadata.output_schema = None
        tool.fn_metadata.wrap_output = False


async def _maybe_paginate(
    result: Any,
    store: ChunkStore,
    max_tokens: int,
    counter: Callable[[str], int],
    page_tool_name: str,
    tool_name: str,
    on_paginate: Callable[[PaginateEvent], None] | None,
) -> list[TextContent]:
    full_text = _content_to_text(result)
    total_tokens = counter(full_text)

    if total_tokens <= max_tokens:
        # Return as list[TextContent] — consistent with paginated responses.
        return _to_content_list(result)

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
    return (
        _try_json_array_split(text, max_tokens, counter)
        or _try_line_split(text, max_tokens, counter)
        or _char_split(text, max_tokens, counter)
    )


def _try_json_array_split(text: str, max_tokens: int, counter: Callable[[str], int]) -> list[str]:
    """Split a JSON array at record boundaries so every chunk is valid JSON."""
    trimmed = text.strip()
    if not (trimmed.startswith("[") and trimmed.endswith("]")):
        return []
    try:
        items = json.loads(trimmed)
        if not isinstance(items, list) or len(items) <= 1:
            return []
    except Exception:
        return []

    chunks: list[str] = []
    batch: list = []

    for item in items:
        batch.append(item)
        if counter(json.dumps(batch)) > max_tokens and len(batch) > 1:
            batch.pop()
            chunks.append(json.dumps(batch, indent=2))
            batch = [item]

    if batch:
        chunks.append(json.dumps(batch, indent=2))

    return chunks if len(chunks) > 1 else []


def _try_line_split(text: str, max_tokens: int, counter: Callable[[str], int]) -> list[str]:
    """Split at newline boundaries — good for logs, CSV, plain text."""
    if "\n" not in text:
        return []

    lines = text.split("\n")
    chunks: list[str] = []
    current: list[str] = []

    for line in lines:
        current.append(line)
        if counter("\n".join(current)) > max_tokens and len(current) > 1:
            current.pop()
            chunks.append("\n".join(current))
            current = [line]

    if current:
        chunks.append("\n".join(current))

    return chunks if len(chunks) > 1 else []


def _char_split(text: str, max_tokens: int, counter: Callable[[str], int]) -> list[str]:
    """Last-resort: binary-search character split."""
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


def _to_content_list(result: Any) -> list[TextContent]:
    """Convert any tool result to list[TextContent] for consistent response format."""
    if isinstance(result, list) and result and hasattr(result[0], "type"):
        return result  # already a content list
    return [TextContent(type="text", text=_content_to_text(result))]


def _emit(
    on_paginate: Callable[[PaginateEvent], None] | None,
    event: PaginateEvent,
) -> None:
    if on_paginate is None:
        return
    try:
        on_paginate(event)
    except Exception:
        pass
