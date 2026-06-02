import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryBackend } from "../src/backends/memory.js";
import { RedisBackend } from "../src/backends/redis.js";

// ─── MemoryBackend ───────────────────────────────────────────────────────────

describe("MemoryBackend", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stores and retrieves chunks", async () => {
    const backend = new MemoryBackend();
    await backend.set("id1", ["a", "b", "c"], 60_000);
    expect(await backend.get("id1")).toEqual(["a", "b", "c"]);
  });

  it("returns null for unknown id", async () => {
    const backend = new MemoryBackend();
    expect(await backend.get("nope")).toBeNull();
  });

  it("returns null after TTL expires", async () => {
    const backend = new MemoryBackend();
    await backend.set("id1", ["data"], 500);
    vi.advanceTimersByTime(501);
    expect(await backend.get("id1")).toBeNull();
  });

  it("evicts expired entries on next set()", async () => {
    const backend = new MemoryBackend();
    await backend.set("old", ["x"], 100);
    expect(backend.size).toBe(1);
    vi.advanceTimersByTime(200);
    await backend.set("new", ["y"], 60_000);
    expect(backend.size).toBe(1); // "old" evicted
  });

  it("delete() removes the entry immediately", async () => {
    const backend = new MemoryBackend();
    await backend.set("id1", ["a", "b"], 60_000);
    await backend.delete("id1");
    expect(await backend.get("id1")).toBeNull();
    expect(backend.size).toBe(0);
  });

  it("refresh() extends the TTL (sliding window)", async () => {
    const backend = new MemoryBackend();
    await backend.set("id1", ["data"], 500);
    vi.advanceTimersByTime(400); // almost expired
    await backend.refresh("id1", 500); // reset the clock
    vi.advanceTimersByTime(400); // would have expired without refresh
    expect(await backend.get("id1")).toEqual(["data"]);
    vi.advanceTimersByTime(200); // now past the refreshed TTL
    expect(await backend.get("id1")).toBeNull();
  });
});

// ─── RedisBackend ────────────────────────────────────────────────────────────

function makeRedisClient() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    store,
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async setex(key: string, seconds: number, value: string) {
      store.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
    },
    async del(key: string) {
      store.delete(key);
    },
    async expire(key: string, seconds: number) {
      const entry = store.get(key);
      if (entry) entry.expiresAt = Date.now() + seconds * 1000;
    },
  };
}

describe("RedisBackend", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stores and retrieves chunks", async () => {
    const redis = makeRedisClient();
    const backend = new RedisBackend(redis);
    await backend.set("id1", ["a", "b"], 60_000);
    expect(await backend.get("id1")).toEqual(["a", "b"]);
  });

  it("namespaces keys with the prefix", async () => {
    const redis = makeRedisClient();
    const backend = new RedisBackend(redis, "test:");
    await backend.set("id1", ["x"], 60_000);
    expect(redis.store.has("test:id1")).toBe(true);
    expect(redis.store.has("id1")).toBe(false);
  });

  it("returns null for unknown id", async () => {
    const redis = makeRedisClient();
    const backend = new RedisBackend(redis);
    expect(await backend.get("nope")).toBeNull();
  });

  it("respects TTL (via Redis SETEX seconds)", async () => {
    const redis = makeRedisClient();
    const backend = new RedisBackend(redis);
    await backend.set("id1", ["data"], 1_000); // 1 second TTL
    vi.advanceTimersByTime(1_001);
    expect(await backend.get("id1")).toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    const redis = makeRedisClient();
    redis.store.set("mcp-paginate:bad", { value: "not-json{{{", expiresAt: Date.now() + 60_000 });
    const backend = new RedisBackend(redis);
    expect(await backend.get("bad")).toBeNull();
  });

  it("delete() removes the entry immediately", async () => {
    const redis = makeRedisClient();
    const backend = new RedisBackend(redis);
    await backend.set("id1", ["a", "b"], 60_000);
    await backend.delete("id1");
    expect(await backend.get("id1")).toBeNull();
  });

  it("refresh() extends the TTL via EXPIRE", async () => {
    const redis = makeRedisClient();
    const backend = new RedisBackend(redis);
    await backend.set("id1", ["data"], 500);
    vi.advanceTimersByTime(400);
    await backend.refresh("id1", 500); // reset
    vi.advanceTimersByTime(400); // would have expired
    expect(await backend.get("id1")).toEqual(["data"]);
  });

  it("accepts a custom ioredis-compatible client", async () => {
    let setCalled = false;
    const mockRedis = {
      async get(_k: string) { return null; },
      async setex(_k: string, _s: number, _v: string) { setCalled = true; },
      async del(_k: string) {},
      async expire(_k: string, _s: number) {},
    };
    const backend = new RedisBackend(mockRedis);
    await backend.set("id", ["chunk"], 5_000);
    expect(setCalled).toBe(true);
  });
});
