/**
 * Edge case and robustness tests for mcp-pager.
 * Covers: boundary conditions, concurrent sessions, error recovery,
 * custom counter failures, security, and LLM behavior edge cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { paginate } from "../src/paginate.js";
import { defaultTokenCounter, estimateContentTokens } from "../src/tokenize.js";

function makeServer() {
  return new McpServer({ name: "test", version: "0.0.1" });
}

type ToolRegistry = Record<string, {
  handler: (args: Record<string, unknown>, extra?: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}>;

function getHandler(server: McpServer, name: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as ToolRegistry;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return (args: Record<string, unknown>) => tool.handler(args, {});
}

function parseMetaBlock(text: string): Record<string, unknown> {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return {};
  try { return JSON.parse(match[1]!) as Record<string, unknown>; } catch { return {}; }
}

// ─── 1. Boundary conditions ───────────────────────────────────────────────────

describe("boundary conditions", () => {
  it("response exactly at maxTokens — no pagination triggered", async () => {
    const maxTokens = 200;
    const server = makeServer();
    paginate(server, { maxTokens });

    // estimateContentTokens counts the full JSON: [{"type":"text","text":"..."}]
    // We need text such that the full serialized content == maxTokens
    // Binary search for the right text length
    let lo = 1, hi = maxTokens * 4;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const content = [{ type: "text" as const, text: "x".repeat(mid) }];
      const tokens = estimateContentTokens(content, defaultTokenCounter);
      if (tokens <= maxTokens) lo = mid; else hi = mid - 1;
    }
    const text = "x".repeat(lo);
    const content = [{ type: "text" as const, text }];
    expect(estimateContentTokens(content, defaultTokenCounter)).toBeLessThanOrEqual(maxTokens);

    server.tool("exact", {}, async () => ({ content }));

    const result = await getHandler(server, "exact")({});
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe(text);
  });

  it("response 1 token over limit — pagination triggers", async () => {
    const maxTokens = 100;
    const server = makeServer();
    paginate(server, { maxTokens });

    // Find text length that just exceeds maxTokens when wrapped in content array
    let lo = 1, hi = maxTokens * 6;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const content = [{ type: "text" as const, text: "x".repeat(mid) }];
      if (estimateContentTokens(content, defaultTokenCounter) <= maxTokens) lo = mid;
      else hi = mid - 1;
    }
    const text = "x".repeat(lo + 4); // push just over
    const content = [{ type: "text" as const, text }];
    expect(estimateContentTokens(content, defaultTokenCounter)).toBeGreaterThan(maxTokens);

    server.tool("over", {}, async () => ({ content }));

    const result = await getHandler(server, "over")({});
    // Pagination triggered — response has 2 content items (data + meta block)
    expect(result.content).toHaveLength(2);
    // Meta block is present and well-formed
    const meta = parseMetaBlock(result.content[1].text);
    expect(typeof meta.hasMore).toBe("boolean");
    expect(typeof meta.pageIndex).toBe("number");
  });

  it("response 1 token under limit — no pagination", async () => {
    const maxTokens = 100;
    const server = makeServer();
    paginate(server, { maxTokens });

    // Find largest text that stays under maxTokens
    let lo = 1, hi = maxTokens * 4;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const content = [{ type: "text" as const, text: "x".repeat(mid) }];
      if (estimateContentTokens(content, defaultTokenCounter) < maxTokens) lo = mid;
      else hi = mid - 1;
    }
    const text = "x".repeat(lo);
    const content = [{ type: "text" as const, text }];
    expect(estimateContentTokens(content, defaultTokenCounter)).toBeLessThan(maxTokens);

    server.tool("under", {}, async () => ({ content }));

    const result = await getHandler(server, "under")({});
    expect(result.content).toHaveLength(1);
  });

  it("very small maxTokens (10) — creates many pages without infinite loop", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 10 });

    server.tool("big", {}, async () => ({
      content: [{ type: "text" as const, text: "x".repeat(400) }],
    }));

    let result = await getHandler(server, "big")({});
    let pages = 1;

    while (true) {
      const meta = parseMetaBlock(result.content[result.content.length - 1].text);
      if (!meta.hasMore) break;
      result = await getHandler(server, "get_next_page")({
        cursor: meta.nextCursor as string,
      });
      pages++;
      expect(pages).toBeLessThan(500); // safety guard
    }

    expect(pages).toBeGreaterThan(5); // many pages created
  });

  it("very large response (100+ pages) — completes without memory issues", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });

    // ~5000 tokens → ~100 pages
    const text = "x".repeat(5000 * 4);
    server.tool("huge", {}, async () => ({
      content: [{ type: "text" as const, text }],
    }));

    let result = await getHandler(server, "huge")({});
    let pages = 1;
    let totalChars = result.content[0].text.length;

    while (true) {
      const meta = parseMetaBlock(result.content[result.content.length - 1].text);
      if (!meta.hasMore) break;
      result = await getHandler(server, "get_next_page")({
        cursor: meta.nextCursor as string,
      });
      totalChars += result.content[0].text.length;
      pages++;
      if (pages > 200) throw new Error("Too many pages");
    }

    expect(pages).toBeGreaterThan(50);
    expect(totalChars).toBe(text.length); // all data recovered
  });
});

// ─── 2. Concurrent session isolation ─────────────────────────────────────────

describe("concurrent session isolation", () => {
  it("two simultaneous sessions use separate ChunkStores", async () => {
    const server1 = makeServer();
    const server2 = makeServer();
    paginate(server1, { maxTokens: 50 });
    paginate(server2, { maxTokens: 50 });

    server1.tool("tool", {}, async () => ({
      content: [{ type: "text" as const, text: "server1-" + "x".repeat(400) }],
    }));
    server2.tool("tool", {}, async () => ({
      content: [{ type: "text" as const, text: "server2-" + "y".repeat(400) }],
    }));

    const [r1, r2] = await Promise.all([
      getHandler(server1, "tool")({}),
      getHandler(server2, "tool")({}),
    ]);

    // Page 1 of each session should contain the right data
    expect(r1.content[0].text).toContain("server1-");
    expect(r2.content[0].text).toContain("server2-");
  });

  it("two parallel calls to same tool create independent sessions", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });

    let callCount = 0;
    server.tool("counter", {}, async () => {
      callCount++;
      return {
        content: [{ type: "text" as const, text: `call-${callCount}-` + "x".repeat(400) }],
      };
    });

    const [r1, r2] = await Promise.all([
      getHandler(server, "counter")({}),
      getHandler(server, "counter")({}),
    ]);

    const meta1 = parseMetaBlock(r1.content[r1.content.length - 1].text);
    const meta2 = parseMetaBlock(r2.content[r2.content.length - 1].text);

    // Cursors should be different (different session IDs)
    expect(meta1.nextCursor).not.toBe(meta2.nextCursor);
  });

  it("cursor from session A cannot access session B data", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });

    server.tool("a", {}, async () => ({
      content: [{ type: "text" as const, text: "AAAA".repeat(200) }],
    }));
    server.tool("b", {}, async () => ({
      content: [{ type: "text" as const, text: "BBBB".repeat(200) }],
    }));

    const [ra, rb] = await Promise.all([
      getHandler(server, "a")({}),
      getHandler(server, "b")({}),
    ]);

    const metaA = parseMetaBlock(ra.content[ra.content.length - 1].text);
    const metaB = parseMetaBlock(rb.content[rb.content.length - 1].text);

    // Fetch page 2 of each session using their own cursors
    const nextA = await getHandler(server, "get_next_page")({ cursor: metaA.nextCursor as string });
    const nextB = await getHandler(server, "get_next_page")({ cursor: metaB.nextCursor as string });

    // Session A pages must never contain session B data and vice versa
    expect(nextA.content[0].text).not.toContain("BBBB");
    expect(nextB.content[0].text).not.toContain("AAAA");
  });
});

// ─── 3. Custom tokenCounter error recovery ────────────────────────────────────

describe("custom tokenCounter error recovery", () => {
  it("crashing tokenCounter falls back gracefully — does not throw", async () => {
    const server = makeServer();
    let callCount = 0;

    paginate(server, {
      maxTokens: 50,
      tokenCounter: (text) => {
        callCount++;
        if (callCount === 1) throw new Error("Counter crashed!");
        return Math.ceil(text.length / 4);
      },
    });

    server.tool("tool", {}, async () => ({
      content: [{ type: "text" as const, text: "x".repeat(400) }],
    }));

    // Should not throw even if counter crashes on first call
    await expect(getHandler(server, "tool")({})).resolves.toBeDefined();
  });

  it("tokenCounter returning NaN — handled safely", async () => {
    const server = makeServer();
    paginate(server, {
      maxTokens: 50,
      tokenCounter: () => NaN,
    });

    server.tool("tool", {}, async () => ({
      content: [{ type: "text" as const, text: "x".repeat(400) }],
    }));

    await expect(getHandler(server, "tool")({})).resolves.toBeDefined();
  });

  it("tokenCounter returning Infinity — handled safely", async () => {
    const server = makeServer();
    paginate(server, {
      maxTokens: 50,
      tokenCounter: () => Infinity,
    });

    server.tool("tool", {}, async () => ({
      content: [{ type: "text" as const, text: "x".repeat(400) }],
    }));

    // Infinity > maxTokens so it will paginate — should not crash
    await expect(getHandler(server, "tool")({})).resolves.toBeDefined();
  });
});

// ─── 4. Error messages ────────────────────────────────────────────────────────

describe("error messages", () => {
  it("expired cursor returns actionable error message", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });

    const result = await getHandler(server, "get_next_page")({ cursor: "invalid" });
    expect(result.isError).toBe(true);
    const msg = result.content[0].text.toLowerCase();
    // Must tell the LLM what to do next
    expect(msg).toMatch(/expired|not found/);
    expect(msg).toMatch(/re-invoke|original tool/);
  });

  it("malformed cursor (truncated base64) returns isError", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });

    const result = await getHandler(server, "get_next_page")({ cursor: "eyJpZ" });
    expect(result.isError).toBe(true);
  });

  it("cursor with valid base64 but wrong shape returns isError", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });

    // Valid base64 but wrong payload shape
    const badCursor = Buffer.from(JSON.stringify({ wrong: "shape" })).toString("base64url");
    const result = await getHandler(server, "get_next_page")({ cursor: badCursor });
    expect(result.isError).toBe(true);
  });
});

// ─── 5. TTL and sliding window ────────────────────────────────────────────────

describe("TTL edge cases", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("cursor expires after TTL if no pages fetched", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50, ttlMs: 1_000 });

    server.tool("tool", {}, async () => ({
      content: [{ type: "text" as const, text: "x".repeat(400) }],
    }));

    const first = await getHandler(server, "tool")({});
    const meta = parseMetaBlock(first.content[first.content.length - 1].text);

    vi.advanceTimersByTime(1_001);

    const result = await getHandler(server, "get_next_page")({
      cursor: meta.nextCursor as string,
    });
    expect(result.isError).toBe(true);
  });

  it("sliding TTL keeps cursor alive as long as pages are fetched regularly", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50, ttlMs: 500 });

    server.tool("tool", {}, async () => ({
      content: [{ type: "text" as const, text: "x".repeat(2000) }],
    }));

    let result = await getHandler(server, "tool")({});
    let pages = 1;

    while (true) {
      vi.advanceTimersByTime(400); // advance near TTL but fetch before expiry
      const meta = parseMetaBlock(result.content[result.content.length - 1].text);
      if (!meta.hasMore) break;
      result = await getHandler(server, "get_next_page")({
        cursor: meta.nextCursor as string,
      });
      pages++;
      if (pages > 50) throw new Error("Infinite loop");
    }

    expect(pages).toBeGreaterThan(1); // completed without expiry
  });
});

// ─── 6. Security ─────────────────────────────────────────────────────────────

describe("security edge cases", () => {
  it("cursor index out of bounds returns isError", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });

    server.tool("tool", {}, async () => ({
      content: [{ type: "text" as const, text: "x".repeat(400) }],
    }));

    const first = await getHandler(server, "tool")({});
    const meta = parseMetaBlock(first.content[first.content.length - 1].text);

    // Decode cursor, change index to huge number, re-encode
    const rawCursor = Buffer.from(meta.nextCursor as string, "base64url").toString("utf8");
    const payload = JSON.parse(rawCursor) as { id: string; index: number };
    payload.index = 9999;
    const tampered = Buffer.from(JSON.stringify(payload)).toString("base64url");

    const result = await getHandler(server, "get_next_page")({ cursor: tampered });
    expect(result.isError).toBe(true);
  });

  it("HMAC-signed cursor — index manipulation is rejected", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50, signingSecret: "secret" });

    server.tool("tool", {}, async () => ({
      content: [{ type: "text" as const, text: "x".repeat(400) }],
    }));

    const first = await getHandler(server, "tool")({});
    const meta = parseMetaBlock(first.content[first.content.length - 1].text);
    const cursor = meta.nextCursor as string;

    // Try to tamper with index (change last chars of payload segment)
    const [payload, sig] = cursor.split(".");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString());
    decoded.index = 0; // try to go back to page 0
    const tamperedPayload = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    const tampered = `${tamperedPayload}.${sig}`;

    const result = await getHandler(server, "get_next_page")({ cursor: tampered });
    expect(result.isError).toBe(true);
  });
});

// ─── 7. LLM behavior simulation ───────────────────────────────────────────────

describe("LLM behavior simulation", () => {
  it("LLM that pages correctly gets all data", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });

    const fullText = "x".repeat(800);
    server.tool("tool", {}, async () => ({
      content: [{ type: "text" as const, text: fullText }],
    }));

    // Simulate well-behaved LLM
    let result = await getHandler(server, "tool")({});
    const parts: string[] = [];

    while (true) {
      parts.push(result.content[0].text);
      const meta = parseMetaBlock(result.content[result.content.length - 1].text);
      if (!meta.hasMore) break;
      result = await getHandler(server, "get_next_page")({
        cursor: meta.nextCursor as string,
      });
    }

    expect(parts.join("")).toBe(fullText); // all data recovered
  });

  it("LLM that calls get_next_page after hasMore=false gets isError", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });

    server.tool("tool", {}, async () => ({
      content: [{ type: "text" as const, text: "x".repeat(400) }],
    }));

    let result = await getHandler(server, "tool")({});
    let lastCursor = "";

    // Page through to the end
    while (true) {
      const meta = parseMetaBlock(result.content[result.content.length - 1].text);
      if (!meta.hasMore) break;
      lastCursor = meta.nextCursor as string;
      result = await getHandler(server, "get_next_page")({ cursor: lastCursor });
    }

    // Last page was consumed — cursor auto-deleted. Calling again should error.
    const afterEnd = await getHandler(server, "get_next_page")({ cursor: lastCursor });
    expect(afterEnd.isError).toBe(true);
  });

  it("LLM re-calling original tool starts a fresh session", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });

    server.tool("tool", {}, async () => ({
      content: [{ type: "text" as const, text: "x".repeat(400) }],
    }));

    const first = await getHandler(server, "tool")({});
    const meta1 = parseMetaBlock(first.content[first.content.length - 1].text);

    // LLM ignores cursor and re-calls original tool
    const second = await getHandler(server, "tool")({});
    const meta2 = parseMetaBlock(second.content[second.content.length - 1].text);

    // Each call creates a new independent session
    expect(meta1.nextCursor).not.toBe(meta2.nextCursor);
  });
});
