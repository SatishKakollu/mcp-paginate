"""
Redis-backed storage for mcp-pager.

Requires redis[asyncio] as an optional dependency:
    pip install "mcp-pager[redis]"

Usage:
    from redis.asyncio import Redis
    from mcp_pager.backends.redis import RedisBackend

    redis = Redis.from_url(os.environ["REDIS_URL"])
    paginate(mcp, store=RedisBackend(redis))
"""
from __future__ import annotations
import json
import math
from typing import Protocol


class _RedisClient(Protocol):
    async def get(self, key: str) -> bytes | None: ...
    async def setex(self, key: str, seconds: int, value: str) -> None: ...
    async def delete(self, key: str) -> None: ...
    async def expire(self, key: str, seconds: int) -> None: ...


class RedisBackend:
    def __init__(self, redis: _RedisClient, prefix: str = "mcp-pager:") -> None:
        self._redis = redis
        self._prefix = prefix

    async def get(self, id: str) -> list[str] | None:
        raw = await self._redis.get(self._prefix + id)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except Exception:
            return None

    async def set(self, id: str, chunks: list[str], ttl_ms: int) -> None:
        ttl_seconds = max(1, math.ceil(ttl_ms / 1000))
        await self._redis.setex(self._prefix + id, ttl_seconds, json.dumps(chunks))

    async def delete(self, id: str) -> None:
        await self._redis.delete(self._prefix + id)

    async def refresh(self, id: str, ttl_ms: int) -> None:
        ttl_seconds = max(1, math.ceil(ttl_ms / 1000))
        await self._redis.expire(self._prefix + id, ttl_seconds)
