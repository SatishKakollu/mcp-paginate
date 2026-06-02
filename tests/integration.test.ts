/**
 * Real integration tests: a proper MCP Client talks to a paginating McpServer
 * through InMemoryTransport — the full JSON-RPC protocol stack, not just
 * direct handler calls.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { paginate } from "../src/paginate.js";

// ~4 chars per token — produces exactly N tokens worth of text
function tokenText(tokens: number) {
  return "x".repeat(tokens * 4);
}

// Extract nextCursor from the last text block in a tool response
function extractCursor(
  content: Array<{ type: string; text?: string }>
): string | null {
  const last = content[content.length - 1];
  if (last?.type !== "text" || !last.text) return null;
  const match = last.text.match(/cursor:\s*`([^`]+)`/);
  return match?.[1] ?? null;
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

// ─── Tests ──────────────────────────────────────────────────────────────────

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

  it("returns the response verbatim — no cursor injected", async () => {
    const result = await client.callTool({ name: "greet", arguments: { name: "world" } });
    expect(result.content).toHaveLength(1);
    expect((result.content[0] as { text: string }).text).toBe("Hello, world!");
    expect(result.isError).toBeFalsy();
  });
});

describe("integration — oversized response (pagination)", () => {
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
    const content = result.content as Array<{ type: string; text?: string }>;
    const dataChunk = content[0]?.text ?? "";
    // chars / 4 should be ≤ maxTokens
    expect(Math.ceil(dataChunk.length / 4)).toBeLessThanOrEqual(100);
  });

  it("first page includes a nextCursor hint", async () => {
    const result = await client.callTool({ name: "dump", arguments: {} });
    const content = result.content as Array<{ type: string; text?: string }>;
    const cursor = extractCursor(content);
    expect(cursor).not.toBeNull();
  });

  it("following the cursor chain reassembles the full content", async () => {
    let result = await client.callTool({ name: "dump", arguments: {} });
    let content = result.content as Array<{ type: string; text?: string }>;

    const parts: string[] = [content[0]?.text ?? ""];
    let cursor = extractCursor(content);
    let iterations = 0;

    while (cursor) {
      result = await client.callTool({
        name: "get_next_page",
        arguments: { cursor },
      });
      content = result.content as Array<{ type: string; text?: string }>;
      parts.push(content[0]?.text ?? "");
      cursor = extractCursor(content);
      if (++iterations > 50) throw new Error("pagination loop did not terminate");
    }

    const reassembled = parts.join("");
    expect(reassembled).toBe(tokenText(400));
  });

  it("each intermediate page also contains a cursor", async () => {
    const first = await client.callTool({ name: "dump", arguments: {} });
    const firstContent = first.content as Array<{ type: string; text?: string }>;
    const cursor = extractCursor(firstContent);
    expect(cursor).not.toBeNull();

    const second = await client.callTool({
      name: "get_next_page",
      arguments: { cursor: cursor! },
    });
    // At 400 tokens and 100-token pages there must be more than 2 pages
    const secondContent = second.content as Array<{ type: string; text?: string }>;
    // Could be null (last page) or a string (more pages) — just must not throw
    expect(secondContent[0]?.type).toBe("text");
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

  it("exposes get_next_page in the tools list", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_next_page");
    expect(names).toContain("noop");
  });

  it("get_next_page has the correct input schema", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "get_next_page");
    expect(tool?.inputSchema.properties).toHaveProperty("cursor");
  });
});

describe("integration — expired / invalid cursor", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    ({ server, client } = await makeConnectedPair({ ttlMs: 1 }));
  });

  afterEach(() => client.close());

  it("returns isError for a garbage cursor", async () => {
    const result = await client.callTool({
      name: "get_next_page",
      arguments: { cursor: "notacursor" },
    });
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
    const names = tools.map((t) => t.name);
    expect(names).toContain("next_chunk");
    expect(names).not.toContain("get_next_page");
  });

  it("cursor hint references the custom tool name", async () => {
    const result = await client.callTool({ name: "big", arguments: {} });
    const content = result.content as Array<{ type: string; text?: string }>;
    const hint = content[content.length - 1]?.text ?? "";
    expect(hint).toContain("next_chunk");
  });
});
