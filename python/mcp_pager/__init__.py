"""
mcp-pager — Token-aware response paging for MCP servers.

    from mcp_pager import paginate
    from mcp.server.fastmcp import FastMCP

    mcp = FastMCP("my-server")
    paginate(mcp, max_tokens=4000)
"""
from .paginate import paginate
from .types import (
    PaginateOptions,
    PaginateEvent,
    ChunkedEvent,
    PageFetchedEvent,
    CursorExpiredEvent,
    StoreBackend,
)
from .chunk_store import ChunkStore, encode_cursor, decode_cursor
from .backends.memory import MemoryBackend
from .tokenize import default_token_counter

__all__ = [
    "paginate",
    "PaginateOptions",
    "PaginateEvent",
    "ChunkedEvent",
    "PageFetchedEvent",
    "CursorExpiredEvent",
    "StoreBackend",
    "ChunkStore",
    "MemoryBackend",
    "encode_cursor",
    "decode_cursor",
    "default_token_counter",
]

__version__ = "0.5.0"
