import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { paginate } from "../src/paginate.js";
import type { PaginateEvent } from "../src/types.js";

function tokenText(tokens: number) {
  return "x".repeat(tokens * 4);
}

function extractCursor(content: Array<{ type: string; text?: string }>): string | null {
  const last = content[content.length - 1];
  if (last?.type !== "text" || !last.text) return null;
  // New JSON format: "nextCursor": "..."
  const jsonMatch = last.text.match(/"nextCursor":\s*"([^"]+)"/);
  if (jsonMatch) return jsonMatch[1] ?? null;
  // Legacy markdown format: cursor: `...`
  const mdMatch = last.text.match(/cursor:\s*`([^`]+)`/);
  return mdMatch?.[1] ?? null;
}

async function makeConnectedPair(options: Parameters<typeof paginate>[1] = {}) {
  const server = new McpServer({ name: "test-server", version: "0.0.1" });
  paginate(server, options);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

// ─── Basic pagination ─────────────────────────────────────────────────────────

describe("integration — small response (no pagination)", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    ({ server, client } = await makeConnectedPair({ maxTokens: 500 }));
    server.tool("greet", { name: z.string() }, async ({ name }) => ({
      content: [{ type: "text" as const, text: `Hello, ${name}!` }],
    }));
  });
  afterEach(() => client.close());

  it("returns verbatim — no cursor injected", async () => {
    const result = await client.callTool({ name: "greet", arguments: { name: "world" } });
    expect(result.content).toHaveLength(1);
    expect((result.content[0] as { text: string }).text).toBe("Hello, world!");
  });
});

describe("integration — oversized response", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    ({ server, client } = await makeConnectedPair({ maxTokens: 100 }));
    server.tool("dump", {}, async () => ({
      content: [{ type: "text" as const, text: tokenText(400) }],
    }));
  });
  afterEach(() => client.close());

  it("first page is within the token limit", async () => {
    const result = await client.callTool({ name: "dump", arguments: {} });
    const dataChunk = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(Math.ceil(dataChunk.length / 4)).toBeLessThanOrEqual(100);
  });

  it("following cursor chain reassembles the full content", async () => {
    let result = await client.callTool({ name: "dump", arguments: {} });
    let content = result.content as Array<{ type: string; text?: string }>;
    const parts = [content[0]?.text ?? ""];
    let cursor = extractCursor(content);
    let iters = 0;
    while (cursor) {
      result = await client.callTool({ name: "get_next_page", arguments: { cursor } });
      content = result.content as Array<{ type: string; text?: string }>;
      parts.push(content[0]?.text ?? "");
      cursor = extractCursor(content);
      if (++iters > 50) throw new Error("did not terminate");
    }
    expect(parts.join("")).toBe(tokenText(400));
  });
});

describe("integration — tool list", () => {
  let client: Client;
  let server: McpServer;
  beforeEach(async () => {
    ({ server, client } = await makeConnectedPair());
    server.tool("noop", {}, async () => ({ content: [] }));
  });
  afterEach(() => client.close());

  it("exposes get_next_page in tools list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("get_next_page");
  });

  it("get_next_page has correct input schema", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "get_next_page");
    expect(tool?.inputSchema.properties).toHaveProperty("cursor");
  });
});

describe("integration — expired cursor", () => {
  let client: Client;
  beforeEach(async () => ({ client } = await makeConnectedPair({ ttlMs: 1 })));
  afterEach(() => client.close());

  it("returns isError for invalid cursor", async () => {
    const result = await client.callTool({ name: "get_next_page", arguments: { cursor: "bad" } });
    expect(result.isError).toBe(true);
  });
});

describe("integration — custom pageToolName", () => {
  let client: Client;
  let server: McpServer;
  beforeEach(async () => {
    ({ server, client } = await makeConnectedPair({ pageToolName: "next_chunk", maxTokens: 50 }));
    server.tool("big", {}, async () => ({
      content: [{ type: "text" as const, text: tokenText(200) }],
    }));
  });
  afterEach(() => client.close());

  it("injects the custom-named tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("next_chunk");
    expect(tools.map((t) => t.name)).not.toContain("get_next_page");
  });

  it("cursor hint references the custom tool name", async () => {
    const result = await client.callTool({ name: "big", arguments: {} });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[content.length - 1]?.text).toContain("next_chunk");
  });
});

// ─── onPaginate logging ───────────────────────────────────────────────────────

describe("integration — onPaginate events (end-to-end)", () => {
  it("fires chunked → page_fetched sequence over real transport", async () => {
    const events: PaginateEvent[] = [];
    const { server, client } = await makeConnectedPair({
      maxTokens: 100,
      onPaginate: (e) => events.push(e),
    });
    server.tool("big", {}, async () => ({
      content: [{ type: "text" as const, text: tokenText(400) }],
    }));

    const first = await client.callTool({ name: "big", arguments: {} });
    const content = first.content as Array<{ type: string; text?: string }>;
    const cursor = extractCursor(content)!;
    await client.callTool({ name: "get_next_page", arguments: { cursor } });
    await client.close();

    expect(events.some((e) => e.type === "chunked")).toBe(true);
    expect(events.some((e) => e.type === "page_fetched")).toBe(true);

    const chunked = events.find((e) => e.type === "chunked")!;
    expect(chunked.type === "chunked" && chunked.toolName).toBe("big");

    const fetched = events.find((e) => e.type === "page_fetched")!;
    expect(fetched.type === "page_fetched" && fetched.pageIndex).toBe(1);
  });
});

// ─── HMAC signing ─────────────────────────────────────────────────────────────

describe("integration — signingSecret (end-to-end)", () => {
  it("pagination works transparently with signing enabled", async () => {
    const { server, client } = await makeConnectedPair({
      maxTokens: 100,
      signingSecret: "integration-secret",
    });
    server.tool("big", {}, async () => ({
      content: [{ type: "text" as const, text: tokenText(400) }],
    }));

    let result = await client.callTool({ name: "big", arguments: {} });
    let content = result.content as Array<{ type: string; text?: string }>;
    const parts = [content[0]?.text ?? ""];
    let cursor = extractCursor(content);
    let iters = 0;
    while (cursor) {
      result = await client.callTool({ name: "get_next_page", arguments: { cursor } });
      content = result.content as Array<{ type: string; text?: string }>;
      parts.push(content[0]?.text ?? "");
      cursor = extractCursor(content);
      if (++iters > 50) throw new Error("loop");
    }
    await client.close();
    expect(parts.join("")).toBe(tokenText(400));
  });

  it("tampered signed cursor returns isError", async () => {
    const { server, client } = await makeConnectedPair({
      maxTokens: 100,
      signingSecret: "integration-secret",
    });
    server.tool("big", {}, async () => ({
      content: [{ type: "text" as const, text: tokenText(400) }],
    }));
    const first = await client.callTool({ name: "big", arguments: {} });
    const content = first.content as Array<{ type: string; text?: string }>;
    const cursor = extractCursor(content)!;
    const tampered = cursor.slice(0, -4) + "XXXX";
    const result = await client.callTool({ name: "get_next_page", arguments: { cursor: tampered } });
    await client.close();
    expect(result.isError).toBe(true);
  });
});
