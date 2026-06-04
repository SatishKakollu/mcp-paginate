import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { paginate } from "../src/paginate.js";
import type { PaginateEvent } from "../src/types.js";

function makeLargeText(tokens: number): string {
  return "x".repeat(tokens * 4);
}

function makeServer() {
  return new McpServer({ name: "test", version: "0.0.1" });
}

describe("paginate()", () => {
  it("returns small responses unchanged", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 100 });
    server.tool("echo", { msg: z.string() }, async ({ msg }) => ({
      content: [{ type: "text" as const, text: msg }],
    }));
    const result = await getHandler(server, "echo")({ msg: "hello" });
    expect(result.content[0].text).toBe("hello");
  });

  it("chunks oversized responses and returns agent-aware metadata", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });
    server.tool("big", {}, async () => ({
      content: [{ type: "text" as const, text: makeLargeText(200) }],
    }));
    const result = await getHandler(server, "big")({});
    expect(result.content.length).toBe(2);
    const meta = parseMetaBlock(result.content[1].text);
    expect(meta.hasMore).toBe(true);
    expect(meta.nextCursor).toBeTruthy();
    expect(meta.pageIndex).toBe(0);
    expect(meta.totalPages).toBeGreaterThan(1);
    expect(meta.remainingPages).toBe(meta.totalPages - 1);
    expect(meta.instruction).toContain("get_next_page");
  });

  it("last page has hasMore=false and completion instruction", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });
    server.tool("big", {}, async () => ({
      content: [{ type: "text" as const, text: makeLargeText(200) }],
    }));
    let result = await getHandler(server, "big")({});
    let iterations = 0;
    while (true) {
      const meta = parseMetaBlock(result.content[result.content.length - 1].text);
      if (!meta.hasMore) {
        expect(meta.remainingPages).toBe(0);
        expect(meta.instruction).toContain("All pages");
        break;
      }
      result = await getHandler(server, "get_next_page")({ cursor: meta.nextCursor });
      if (++iterations > 50) throw new Error("Infinite loop");
    }
  });

  it("get_next_page advances through all pages", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });
    server.tool("big", {}, async () => ({
      content: [{ type: "text" as const, text: makeLargeText(200) }],
    }));
    let result = await getHandler(server, "big")({});
    let pages = 1;
    while (true) {
      const meta = parseMetaBlock(result.content[result.content.length - 1].text);
      if (!meta.hasMore) break;
      result = await getHandler(server, "get_next_page")({ cursor: meta.nextCursor });
      pages++;
      if (pages > 50) throw new Error("Infinite loop");
    }
    expect(pages).toBeGreaterThan(1);
  });

  it("get_next_page returns error for invalid cursor", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });
    const result = await getHandler(server, "get_next_page")({ cursor: "invalid" });
    expect(result.isError).toBe(true);
  });

  it("injects get_next_page into the tool list", () => {
    const server = makeServer();
    paginate(server, {});
    expect(getToolNames(server)).toContain("get_next_page");
  });

  it("respects custom pageToolName", () => {
    const server = makeServer();
    paginate(server, { pageToolName: "next_chunk" });
    expect(getToolNames(server)).toContain("next_chunk");
    expect(getToolNames(server)).not.toContain("get_next_page");
  });
});

// ─── onPaginate logging ───────────────────────────────────────────────────────

describe("onPaginate events", () => {
  it("fires chunked event with correct toolName and chunk count", async () => {
    const events: PaginateEvent[] = [];
    const server = makeServer();
    paginate(server, { maxTokens: 50, onPaginate: (e) => events.push(e) });
    server.tool("big", {}, async () => ({
      content: [{ type: "text" as const, text: makeLargeText(200) }],
    }));
    await getHandler(server, "big")({});
    const chunked = events.find((e) => e.type === "chunked");
    expect(chunked).toBeDefined();
    expect(chunked?.type === "chunked" && chunked.toolName).toBe("big");
    expect(chunked?.type === "chunked" && chunked.totalChunks).toBeGreaterThan(1);
    expect(chunked?.type === "chunked" && chunked.totalTokens).toBeGreaterThan(50);
  });

  it("fires page_fetched event with correct pageIndex and totalPages", async () => {
    const events: PaginateEvent[] = [];
    const server = makeServer();
    paginate(server, { maxTokens: 50, onPaginate: (e) => events.push(e) });
    server.tool("big", {}, async () => ({
      content: [{ type: "text" as const, text: makeLargeText(200) }],
    }));
    const first = await getHandler(server, "big")({});
    const { nextCursor } = parseMetaBlock(first.content[first.content.length - 1].text);
    await getHandler(server, "get_next_page")({ cursor: nextCursor });
    const fetched = events.find((e) => e.type === "page_fetched");
    expect(fetched).toBeDefined();
    expect(fetched?.type === "page_fetched" && fetched.pageIndex).toBe(1);
  });

  it("fires cursor_expired event for bad cursor", async () => {
    const events: PaginateEvent[] = [];
    const server = makeServer();
    paginate(server, { maxTokens: 50, onPaginate: (e) => events.push(e) });
    await getHandler(server, "get_next_page")({ cursor: "bad" });
    expect(events.some((e) => e.type === "cursor_expired")).toBe(true);
  });

  it("does not crash the pipeline if onPaginate throws", async () => {
    const server = makeServer();
    paginate(server, {
      maxTokens: 50,
      onPaginate: () => { throw new Error("logger crashed"); },
    });
    server.tool("big", {}, async () => ({
      content: [{ type: "text" as const, text: makeLargeText(200) }],
    }));
    // Should not throw
    await expect(getHandler(server, "big")({})).resolves.toBeDefined();
  });
});

// ─── HMAC signing ─────────────────────────────────────────────────────────────

describe("signingSecret", () => {
  it("pagination still works end-to-end when signing is enabled", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50, signingSecret: "my-secret" });
    server.tool("big", {}, async () => ({
      content: [{ type: "text" as const, text: makeLargeText(200) }],
    }));
    let result = await getHandler(server, "big")({});
    let pages = 1;
    while (true) {
      const meta = parseMetaBlock(result.content[result.content.length - 1].text);
      if (!meta.hasMore) break;
      result = await getHandler(server, "get_next_page")({ cursor: meta.nextCursor });
      pages++;
      if (pages > 50) throw new Error("Infinite loop");
    }
    expect(pages).toBeGreaterThan(1);
  });

  it("rejects a tampered cursor", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50, signingSecret: "my-secret" });
    server.tool("big", {}, async () => ({
      content: [{ type: "text" as const, text: makeLargeText(200) }],
    }));
    const first = await getHandler(server, "big")({});
    const { nextCursor } = parseMetaBlock(first.content[first.content.length - 1].text);
    const tampered = nextCursor.slice(0, -4) + "XXXX";
    const result = await getHandler(server, "get_next_page")({ cursor: tampered });
    expect(result.isError).toBe(true);
  });
});

// ─── Smart chunking ───────────────────────────────────────────────────────────

describe("smart chunking", () => {
  it("JSON array — each chunk is valid parseable JSON", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 100 });

    const records = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1, name: `Employee ${i + 1}`, department: "Engineering",
    }));

    server.tool("list", {}, async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(records, null, 2) }],
    }));

    let result = await getHandler(server, "list")({});
    let pages = 0;

    while (true) {
      const dataChunk = result.content[0].text;
      // Every chunk must be valid JSON
      expect(() => JSON.parse(dataChunk)).not.toThrow();
      const parsed = JSON.parse(dataChunk) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      pages++;

      const meta = parseMetaBlock(result.content[result.content.length - 1].text);
      if (!meta.hasMore) break;
      result = await getHandler(server, "get_next_page")({ cursor: meta.nextCursor });
      if (pages > 50) throw new Error("Infinite loop");
    }
    expect(pages).toBeGreaterThan(1);
  });

  it("JSON array — all records present across pages (no data lost)", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 100 });

    const records = Array.from({ length: 30 }, (_, i) => ({ id: i + 1 }));

    server.tool("list", {}, async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(records, null, 2) }],
    }));

    let result = await getHandler(server, "list")({});
    const allIds: number[] = [];

    while (true) {
      const parsed = JSON.parse(result.content[0].text) as Array<{ id: number }>;
      allIds.push(...parsed.map(r => r.id));
      const meta = parseMetaBlock(result.content[result.content.length - 1].text);
      if (!meta.hasMore) break;
      result = await getHandler(server, "get_next_page")({ cursor: meta.nextCursor });
    }

    expect(allIds.sort((a, b) => a - b)).toEqual(records.map(r => r.id));
  });

  it("wrapped JSON object — splits largest array field, preserves wrapper", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 100 });

    // Pokémon-style: single object with a large nested array
    const payload = {
      id: 6,
      name: "charizard",
      weight: 905,
      moves: Array.from({ length: 50 }, (_, i) => ({
        move: { name: `move-${i}`, url: `https://pokeapi.co/api/v2/move/${i}/` },
        version_group_details: [{ level_learned_at: i, move_learn_method: { name: "level-up" } }],
      })),
      abilities: [{ ability: { name: "blaze" }, is_hidden: false }],
    };

    server.tool("pokemon", {}, async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    }));

    let result = await getHandler(server, "pokemon")({});
    let pages = 0;

    while (true) {
      const chunk = result.content[0].text;
      // Every chunk must be valid JSON with the wrapper preserved
      const parsed = JSON.parse(chunk) as Record<string, unknown>;
      expect(parsed.name).toBe("charizard");       // wrapper preserved
      expect(parsed.weight).toBe(905);             // wrapper preserved
      expect(Array.isArray(parsed.moves)).toBe(true); // moves array present
      pages++;
      const meta = parseMetaBlock(result.content[result.content.length - 1].text);
      if (!meta.hasMore) break;
      result = await getHandler(server, "get_next_page")({ cursor: meta.nextCursor });
      if (pages > 50) throw new Error("Infinite loop");
    }
    expect(pages).toBeGreaterThan(1);
  });

  it("plain text logs — splits at line boundaries", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });

    const logs = Array.from({ length: 200 }, (_, i) =>
      `2026-06-02T${String(i).padStart(6, "0")}Z INFO service processed request ${i}`
    ).join("\n");

    server.tool("logs", {}, async () => ({
      content: [{ type: "text" as const, text: logs }],
    }));

    let result = await getHandler(server, "logs")({});
    const parts: string[] = [];

    while (true) {
      parts.push(result.content[0].text);
      const meta = parseMetaBlock(result.content[result.content.length - 1].text);
      if (!meta.hasMore) break;
      result = await getHandler(server, "get_next_page")({ cursor: meta.nextCursor });
    }

    // Every non-empty line in a chunk must exist verbatim in the original
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (line.trim()) expect(logs).toContain(line);
      }
    }
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ToolRegistry = Record<string, { handler: (args: Record<string, unknown>, extra?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }>;

function getHandler(server: McpServer, name: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as ToolRegistry;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return (args: Record<string, unknown>) => tool.handler(args, {});
}

function getToolNames(server: McpServer): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Object.keys((server as any)._registeredTools as ToolRegistry);
}


interface MetaBlock {
  hasMore: boolean;
  pageIndex: number;
  totalPages: number;
  remainingPages: number;
  nextCursor: string;
  instruction: string;
}

function parseMetaBlock(text: string): MetaBlock {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) throw new Error(`No JSON meta block found in: ${text}`);
  return JSON.parse(match[1]!) as MetaBlock;
}
