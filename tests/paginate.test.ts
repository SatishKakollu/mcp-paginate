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

  it("chunks oversized responses and returns a nextCursor", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });
    server.tool("big", {}, async () => ({
      content: [{ type: "text" as const, text: makeLargeText(200) }],
    }));
    const result = await getHandler(server, "big")({});
    expect(result.content.length).toBeGreaterThanOrEqual(2);
    expect(result.content[result.content.length - 1].text).toContain("get_next_page");
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
      const hint = result.content[result.content.length - 1]?.text as string;
      const match = hint?.match(/cursor:\s*`([^`]+)`/);
      if (!match) break;
      result = await getHandler(server, "get_next_page")({ cursor: match[1] });
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
    const hint = first.content[first.content.length - 1]?.text as string;
    const cursor = hint.match(/cursor:\s*`([^`]+)`/)?.[1]!;
    await getHandler(server, "get_next_page")({ cursor });
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
      const hint = result.content[result.content.length - 1]?.text as string;
      const match = hint?.match(/cursor:\s*`([^`]+)`/);
      if (!match) break;
      result = await getHandler(server, "get_next_page")({ cursor: match[1] });
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
    const hint = first.content[first.content.length - 1]?.text as string;
    const cursor = hint.match(/cursor:\s*`([^`]+)`/)?.[1]!;
    const tampered = cursor.slice(0, -4) + "XXXX"; // corrupt last 4 chars
    const result = await getHandler(server, "get_next_page")({ cursor: tampered });
    expect(result.isError).toBe(true);
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
