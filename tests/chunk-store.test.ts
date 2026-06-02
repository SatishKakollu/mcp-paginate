import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChunkStore, encodeCursor, decodeCursor } from "../src/chunk-store.js";

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a payload", () => {
    const payload = { id: "abc-123", index: 2 };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it("returns null for garbage input", () => {
    expect(decodeCursor("not-base64!!!")).toBeNull();
    expect(decodeCursor(encodeCursor({ id: "x", index: 0 }).slice(0, 3))).toBeNull();
  });
});

describe("ChunkStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves and retrieves the first chunk", async () => {
    const store = new ChunkStore(60_000);
    const id = await store.save(["page1", "page2", "page3"]);
    const cursor = encodeCursor({ id, index: 0 });
    const result = await store.get(cursor);
    expect(result?.chunk).toBe("page1");
    expect(result?.nextCursor).not.toBeNull();
  });

  it("returns null nextCursor on the last page", async () => {
    const store = new ChunkStore(60_000);
    const id = await store.save(["only"]);
    const cursor = encodeCursor({ id, index: 0 });
    expect((await store.get(cursor))?.nextCursor).toBeNull();
  });

  it("chains through all pages via nextCursor", async () => {
    const store = new ChunkStore(60_000);
    const chunks = ["a", "b", "c"];
    const id = await store.save(chunks);
    let cursor: string | null = encodeCursor({ id, index: 0 });
    const collected: string[] = [];
    while (cursor) {
      const res = await store.get(cursor);
      expect(res).not.toBeNull();
      collected.push(res!.chunk);
      cursor = res!.nextCursor;
    }
    expect(collected).toEqual(chunks);
  });

  it("returns null after TTL expires", async () => {
    const store = new ChunkStore(1_000);
    const id = await store.save(["data"]);
    const cursor = encodeCursor({ id, index: 0 });
    vi.advanceTimersByTime(1_001);
    expect(await store.get(cursor)).toBeNull();
  });

  it("returns null for unknown cursor id", async () => {
    const store = new ChunkStore(60_000);
    const cursor = encodeCursor({ id: "nonexistent", index: 0 });
    expect(await store.get(cursor)).toBeNull();
  });

  it("auto-deletes entry after last page is served", async () => {
    // Use a custom backend that tracks delete() calls
    let deletedId: string | null = null;
    const chunks = ["only-page"];
    const backend = {
      async get(_id: string) { return chunks; },
      async set(_id: string, _c: string[], _ttl: number) {},
      async delete(id: string) { deletedId = id; },
    };
    const store = new ChunkStore(60_000, backend);
    const id = await store.save(chunks);
    const cursor = encodeCursor({ id, index: 0 });
    const result = await store.get(cursor);
    expect(result?.nextCursor).toBeNull();
    expect(deletedId).toBe(id);
  });
});
