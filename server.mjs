/**
 * mcp-pager standalone demo server.
 * Used by Glama for server verification.
 * Also useful as a minimal working example.
 *
 * Run: node server.mjs
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { paginate } from "mcp-pager";
import { z } from "zod";
const server = new McpServer({ name: "mcp-pager-demo", version: "0.6.0" });

// One line — every tool is now token-safe.
paginate(server, { maxTokens: 4000 });

server.tool(
  "list_records",
  "List demo records — returns a large dataset to demonstrate pagination",
  { limit: z.number().int().min(1).max(2000).optional().describe("Number of records (default: 500)") },
  async ({ limit = 500 }) => {
    const records = Array.from({ length: limit }, (_, i) => ({
      id: i + 1,
      name: `Record ${i + 1}`,
      department: ["Engineering", "Sales", "Marketing", "HR", "Finance"][i % 5],
      value: Math.round(Math.random() * 100000) / 100,
    }));
    return { content: [{ type: "text", text: JSON.stringify(records, null, 2) }] };
  }
);

server.tool(
  "fetch_logs",
  "Fetch demo log lines — returns large log output to demonstrate pagination",
  {
    service: z.string().describe("Service name"),
    lines: z.number().int().min(1).max(5000).optional().describe("Number of lines (default: 500)"),
  },
  async ({ service, lines = 500 }) => {
    const levels = ["INFO", "WARN", "ERROR", "DEBUG"];
    const logs = Array.from({ length: lines }, (_, i) => ({
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
      level: levels[i % 4],
      service,
      message: `Request ${i + 1} processed — status ${i % 20 === 0 ? 500 : 200}`,
    }));
    return { content: [{ type: "text", text: JSON.stringify(logs, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[mcp-pager] Demo server running — tools: list_records, fetch_logs, get_next_page`);
