import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChunkStore, encodeCursor, decodeCursor } from "../src/chunk-store.js";

const SECRET = "test-secret-key";

describe("encodeCursor / decodeCursor — unsigned", () => {
  it("round-trips a payload", () => {
    const payload = { id: "abc-123", index: 2 };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it("returns null for garbage input", () => {
    expect(decodeCursor("not-base64!!!")).toBeNull();
    expect(decodeCursor(encodeCursor({ id: "x", index: 0 }).slice(0, 3))).toBeNull();
  });
});

describe("encodeCursor / decodeCursor — HMAC signed", () => {
  it("round-trips a signed payload", () => {
    const payload = { id: "abc-123", index: 2 };
    const cursor = encodeCursor(payload, SECRET);
    expect(cursor).toContain("."); // has signature segment
    expect(decodeCursor(cursor, SECRET)).toEqual(payload);
  });

  it("returns null for wrong secret", () => {
    const cursor = encodeCursor({ id: "x", index: 0 }, SECRET);
    expect(decodeCursor(cursor, "wrong-secret")).toBeNull();
  });

  it("returns null for tampered payload", () => {
    const cursor = encodeCursor({ id: "x", index: 0 }, SECRET);
    const [payload, sig] = cursor.split(".");
    const tampered = `${payload!.slice(0, -2)}aa.${sig}`;
    expect(decodeCursor(tampered, SECRET)).toBeNull();
  });

  it("returns null for unsigned cursor when secret expected", () => {
    const unsigned = encodeCursor({ id: "x", index: 0 }); // no secret
    expect(decodeCursor(unsigned, SECRET)).toBeNull(); // no dot → rejected
  });
});

describe("ChunkStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves and retrieves the first chunk", async () => {
    const store = new ChunkStore(60_000);
    const id = await store.save(["page1", "page2", "page3"]);
    const cursor = store.createCursor(id, 0);
    const result = await store.get(cursor);
    expect(result?.chunk).toBe("page1");
    expect(result?.nextCursor).not.toBeNull();
    expect(result?.pageIndex).toBe(0);
    expect(result?.totalPages).toBe(3);
  });

  it("returns null nextCursor on the last page", async () => {
    const store = new ChunkStore(60_000);
    const id = await store.save(["only"]);
    const cursor = store.createCursor(id, 0);
    const result = await store.get(cursor);
    expect(result?.nextCursor).toBeNull();
    expect(result?.pageIndex).toBe(0);
    expect(result?.totalPages).toBe(1);
  });

  it("chains through all pages via nextCursor", async () => {
    const store = new ChunkStore(60_000);
    const chunks = ["a", "b", "c"];
    const id = await store.save(chunks);
    let cursor: string | null = store.createCursor(id, 0);
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
    const cursor = store.createCursor(id, 0);
    vi.advanceTimersByTime(1_001);
    expect(await store.get(cursor)).toBeNull();
  });

  it("returns null for unknown cursor id", async () => {
    const store = new ChunkStore(60_000);
    const cursor = encodeCursor({ id: "nonexistent", index: 0 });
    expect(await store.get(cursor)).toBeNull();
  });

  it("auto-deletes entry after last page is served", async () => {
    let deletedId: string | null = null;
    const backend = {
      async get(_id: string) { return ["only-page"]; },
      async set(_id: string, _c: string[], _ttl: number) {},
      async delete(id: string) { deletedId = id; },
    };
    const store = new ChunkStore(60_000, backend);
    const id = await store.save(["only-page"]);
    const cursor = store.createCursor(id, 0);
    await store.get(cursor);
    expect(deletedId).toBe(id);
  });

  it("signs and verifies cursors when signingSecret provided", async () => {
    const store = new ChunkStore(60_000, undefined, SECRET);
    const id = await store.save(["p1", "p2"]);
    const cursor = store.createCursor(id, 0);
    expect(cursor).toContain("."); // signed
    const result = await store.get(cursor);
    expect(result?.chunk).toBe("p1");
  });

  it("rejects unsigned cursor when signingSecret is set", async () => {
    const store = new ChunkStore(60_000, undefined, SECRET);
    const id = await store.save(["p1"]);
    const unsignedCursor = encodeCursor({ id, index: 0 }); // no secret
    expect(await store.get(unsignedCursor)).toBeNull();
  });

  it("sliding TTL — fetching a page resets the expiry", async () => {
    const store = new ChunkStore(500); // 500ms TTL
    const id = await store.save(["p1", "p2"]);
    const cursor = store.createCursor(id, 0);
    vi.advanceTimersByTime(400); // almost expired
    await store.get(cursor);    // fetches p1, resets TTL
    vi.advanceTimersByTime(400); // would have expired without refresh
    const cursor2 = store.createCursor(id, 1);
    expect(await store.get(cursor2)).not.toBeNull(); // p2 still alive
  });
});
