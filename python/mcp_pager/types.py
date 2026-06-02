from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Protocol, runtime_checkable


@dataclass
class ChunkedEvent:
    type: Literal["chunked"] = field(default="chunked", init=False)
    tool_name: str = ""
    total_tokens: int = 0
    total_chunks: int = 0


@dataclass
class PageFetchedEvent:
    type: Literal["page_fetched"] = field(default="page_fetched", init=False)
    page_index: int = 0
    total_pages: int = 0
    has_more: bool = False


@dataclass
class CursorExpiredEvent:
    type: Literal["cursor_expired"] = field(default="cursor_expired", init=False)


PaginateEvent = ChunkedEvent | PageFetchedEvent | CursorExpiredEvent


@runtime_checkable
class StoreBackend(Protocol):
    async def get(self, id: str) -> list[str] | None: ...
    async def set(self, id: str, chunks: list[str], ttl_ms: int) -> None: ...
    async def delete(self, id: str) -> None: ...
    async def refresh(self, id: str, ttl_ms: int) -> None: ...


@dataclass
class PaginateOptions:
    max_tokens: int = 4000
    ttl_ms: int = 10 * 60 * 1000  # 10 minutes sliding window
    token_counter: Callable[[str], int] | None = None
    page_tool_name: str = "get_next_page"
    store: StoreBackend | None = None
    signing_secret: str | None = None
    on_paginate: Callable[[PaginateEvent], None] | None = None
