from __future__ import annotations
import time
from dataclasses import dataclass, field


@dataclass
class _Entry:
    chunks: list[str]
    expires_at: float  # epoch seconds


class MemoryBackend:
    def __init__(self) -> None:
        self._store: dict[str, _Entry] = {}

    async def get(self, id: str) -> list[str] | None:
        entry = self._store.get(id)
        if entry is None:
            return None
        if time.time() > entry.expires_at:
            del self._store[id]
            return None
        return entry.chunks

    async def set(self, id: str, chunks: list[str], ttl_ms: int) -> None:
        self._evict()
        self._store[id] = _Entry(chunks=chunks, expires_at=time.time() + ttl_ms / 1000)

    async def delete(self, id: str) -> None:
        self._store.pop(id, None)

    async def refresh(self, id: str, ttl_ms: int) -> None:
        entry = self._store.get(id)
        if entry is not None:
            entry.expires_at = time.time() + ttl_ms / 1000

    def _evict(self) -> None:
        now = time.time()
        expired = [k for k, v in self._store.items() if now > v.expires_at]
        for k in expired:
            del self._store[k]

    @property
    def size(self) -> int:
        return len(self._store)
