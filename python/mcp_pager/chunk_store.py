from __future__ import annotations
import base64
import hashlib
import hmac
import json
from uuid import uuid4

from .backends.memory import MemoryBackend
from .types import StoreBackend


class ChunkStore:
    def __init__(
        self,
        ttl_ms: int,
        backend: StoreBackend | None = None,
        signing_secret: str | None = None,
    ) -> None:
        self.ttl_ms = ttl_ms
        self.backend = backend or MemoryBackend()
        self.signing_secret = signing_secret

    async def save(self, chunks: list[str]) -> str:
        id = str(uuid4())
        await self.backend.set(id, chunks, self.ttl_ms)
        return id

    def create_cursor(self, id: str, index: int) -> str:
        return encode_cursor({"id": id, "index": index}, self.signing_secret)

    async def get(self, cursor: str) -> dict | None:
        payload = decode_cursor(cursor, self.signing_secret)
        if payload is None:
            return None

        chunks = await self.backend.get(payload["id"])
        if chunks is None:
            return None

        idx = payload["index"]
        if idx >= len(chunks):
            return None

        chunk = chunks[idx]
        is_last = idx >= len(chunks) - 1
        next_cursor = None if is_last else self.create_cursor(payload["id"], idx + 1)

        if is_last:
            await self.backend.delete(payload["id"])
        else:
            await self.backend.refresh(payload["id"], self.ttl_ms)

        return {
            "chunk": chunk,
            "next_cursor": next_cursor,
            "page_index": idx,
            "total_pages": len(chunks),
        }


def encode_cursor(payload: dict, secret: str | None = None) -> str:
    data = json.dumps(payload, separators=(",", ":")).encode()
    encoded = base64.urlsafe_b64encode(data).rstrip(b"=").decode()
    if not secret:
        return encoded
    sig = hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=").decode()
    return f"{encoded}.{sig_b64}"


def decode_cursor(cursor: str, secret: str | None = None) -> dict | None:
    try:
        encoded = cursor

        if secret:
            dot = cursor.rfind(".")
            if dot == -1:
                return None
            encoded = cursor[:dot]
            sig = cursor[dot + 1:]
            expected = hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest()
            expected_b64 = base64.urlsafe_b64encode(expected).rstrip(b"=").decode()
            if not hmac.compare_digest(sig, expected_b64):
                return None

        # Re-add base64 padding
        pad = 4 - len(encoded) % 4
        if pad != 4:
            encoded += "=" * pad

        raw = base64.urlsafe_b64decode(encoded).decode()
        parsed = json.loads(raw)

        if isinstance(parsed, dict) and "id" in parsed and "index" in parsed:
            return parsed
        return None
    except Exception:
        return None
