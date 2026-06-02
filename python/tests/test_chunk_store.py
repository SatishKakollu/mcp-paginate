import pytest
import time
from unittest.mock import AsyncMock, patch
from mcp_pager.chunk_store import ChunkStore, encode_cursor, decode_cursor
from mcp_pager.backends.memory import MemoryBackend

SECRET = "test-secret"


# ─── Cursor encode/decode ────────────────────────────────────────────────────

def test_encode_decode_unsigned():
    payload = {"id": "abc-123", "index": 2}
    assert decode_cursor(encode_cursor(payload)) == payload


def test_encode_decode_signed():
    payload = {"id": "abc-123", "index": 2}
    cursor = encode_cursor(payload, SECRET)
    assert "." in cursor
    assert decode_cursor(cursor, SECRET) == payload


def test_wrong_secret_returns_none():
    cursor = encode_cursor({"id": "x", "index": 0}, SECRET)
    assert decode_cursor(cursor, "wrong") is None


def test_tampered_payload_returns_none():
    cursor = encode_cursor({"id": "x", "index": 0}, SECRET)
    payload, sig = cursor.rsplit(".", 1)
    tampered = payload[:-2] + "ZZ." + sig
    assert decode_cursor(tampered, SECRET) is None


def test_unsigned_cursor_rejected_when_secret_set():
    unsigned = encode_cursor({"id": "x", "index": 0})
    assert decode_cursor(unsigned, SECRET) is None


# ─── ChunkStore ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_save_and_retrieve():
    store = ChunkStore(60_000)
    id_ = await store.save(["p1", "p2", "p3"])
    cursor = store.create_cursor(id_, 0)
    result = await store.get(cursor)
    assert result["chunk"] == "p1"
    assert result["page_index"] == 0
    assert result["total_pages"] == 3
    assert result["next_cursor"] is not None


@pytest.mark.asyncio
async def test_last_page_has_no_next_cursor():
    store = ChunkStore(60_000)
    id_ = await store.save(["only"])
    cursor = store.create_cursor(id_, 0)
    result = await store.get(cursor)
    assert result["next_cursor"] is None


@pytest.mark.asyncio
async def test_full_chain():
    store = ChunkStore(60_000)
    chunks = ["a", "b", "c"]
    id_ = await store.save(chunks)
    cursor = store.create_cursor(id_, 0)
    collected = []
    while cursor:
        result = await store.get(cursor)
        collected.append(result["chunk"])
        cursor = result["next_cursor"]
    assert collected == chunks


@pytest.mark.asyncio
async def test_expired_returns_none():
    store = ChunkStore(1)  # 1ms TTL
    id_ = await store.save(["data"])
    cursor = store.create_cursor(id_, 0)
    time.sleep(0.01)  # wait for expiry
    assert await store.get(cursor) is None


@pytest.mark.asyncio
async def test_auto_delete_on_last_page():
    deleted = []
    backend = MemoryBackend()
    original_delete = backend.delete

    async def tracking_delete(id_):
        deleted.append(id_)
        await original_delete(id_)

    backend.delete = tracking_delete
    store = ChunkStore(60_000, backend)
    id_ = await store.save(["only"])
    cursor = store.create_cursor(id_, 0)
    await store.get(cursor)
    assert id_ in deleted


@pytest.mark.asyncio
async def test_sliding_ttl():
    store = ChunkStore(200, MemoryBackend())  # 200ms TTL
    id_ = await store.save(["p1", "p2"])
    cursor = store.create_cursor(id_, 0)
    time.sleep(0.15)  # almost expired
    await store.get(cursor)  # fetches p1, resets TTL
    time.sleep(0.15)  # would have expired without refresh
    cursor2 = store.create_cursor(id_, 1)
    assert await store.get(cursor2) is not None  # still alive


@pytest.mark.asyncio
async def test_signed_store_end_to_end():
    store = ChunkStore(60_000, signing_secret=SECRET)
    id_ = await store.save(["p1", "p2"])
    cursor = store.create_cursor(id_, 0)
    assert "." in cursor
    result = await store.get(cursor)
    assert result["chunk"] == "p1"


@pytest.mark.asyncio
async def test_unsigned_cursor_rejected_by_signed_store():
    store = ChunkStore(60_000, signing_secret=SECRET)
    id_ = await store.save(["p1"])
    unsigned = encode_cursor({"id": id_, "index": 0})
    assert await store.get(unsigned) is None
