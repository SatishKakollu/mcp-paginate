import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { paginate } from "../src/paginate.js";

function makeLargeText(tokens: number): string {
  // ~4 chars per token
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

    const handler = getToolHandler(server, "echo");
    const result = await handler({ msg: "hello" });
    expect(result.content[0].text).toBe("hello");
    expect(result.content).toHaveLength(1);
  });

  it("chunks oversized responses and returns a nextCursor", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });

    server.tool("big", {}, async () => ({
      content: [{ type: "text" as const, text: makeLargeText(200) }],
    }));

    const handler = getToolHandler(server, "big");
    const result = await handler({});

    // Should have a chunk + a cursor hint
    expect(result.content.length).toBeGreaterThanOrEqual(2);
    const hint = result.content[result.content.length - 1].text as string;
    expect(hint).toContain("get_next_page");
    expect(hint).toContain("cursor:");
  });

  it("get_next_page advances through all pages", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50 });

    server.tool("big", {}, async () => ({
      content: [{ type: "text" as const, text: makeLargeText(200) }],
    }));

    const bigHandler = getToolHandler(server, "big");
    const nextPage = getToolHandler(server, "get_next_page");

    let result = await bigHandler({});
    let pages = 1;

    while (true) {
      const hint = result.content[result.content.length - 1]?.text as string;
      const match = hint?.match(/cursor:\s*`([^`]+)`/);
      if (!match) break;
      result = await nextPage({ cursor: match[1] });
      pages++;
      if (pages > 50) throw new Error("Infinite pagination loop");
    }

    expect(pages).toBeGreaterThan(1);
  });

  it("get_next_page returns error for expired/unknown cursor", async () => {
    const server = makeServer();
    paginate(server, { maxTokens: 50, ttlMs: 1 });

    const nextPage = getToolHandler(server, "get_next_page");
    const result = await nextPage({ cursor: "invalidddddd" });
    expect(result.isError).toBe(true);
  });

  it("injects get_next_page into the tool list", () => {
    const server = makeServer();
    paginate(server, {});
    const tools = getRegisteredToolNames(server);
    expect(tools).toContain("get_next_page");
  });

  it("respects custom pageToolName", () => {
    const server = makeServer();
    paginate(server, { pageToolName: "next_chunk" });
    const tools = getRegisteredToolNames(server);
    expect(tools).toContain("next_chunk");
    expect(tools).not.toContain("get_next_page");
  });
});

// ---------------------------------------------------------------------------
// Test helpers — reach into McpServer internals for handler access
// ---------------------------------------------------------------------------

type ToolRegistry = Record<string, { handler: (args: Record<string, unknown>, extra?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }>;

function getToolHandler(server: McpServer, name: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as ToolRegistry;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return (args: Record<string, unknown>) => tool.handler(args, {});
}

function getRegisteredToolNames(server: McpServer): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as ToolRegistry;
  return Object.keys(tools);
}
