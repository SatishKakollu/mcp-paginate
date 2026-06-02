/**
 * mcp-paginate demo server
 *
 * Shows three realistic tools that return large payloads.
 * Without mcp-paginate these would overflow context windows;
 * with it the LLM pages through seamlessly.
 *
 * Run:
 *   npx tsx examples/demo-server.ts
 *
 * Then connect any MCP client (Claude Desktop, mcp-cli, etc.)
 * and call list_records, list_files, or fetch_logs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { paginate } from "../src/index.js";

// ─── Server setup ───────────────────────────────────────────────────────────

const server = new McpServer({
  name: "mcp-paginate-demo",
  version: "0.2.0",
});

/**
 * BEFORE mcp-paginate: the LLM receives a truncated response or an error
 * when tool output exceeds its context window.
 *
 * AFTER (one line): every tool below automatically paginates.
 */
paginate(server, {
  maxTokens: 1000, // low for demo — use 4000+ in production
});

// ─── Tool 1: large database query ───────────────────────────────────────────

interface Record {
  id: number;
  name: string;
  email: string;
  department: string;
  salary: number;
  startDate: string;
}

function generateEmployees(count: number): Record[] {
  const departments = ["Engineering", "Sales", "Marketing", "HR", "Finance"];
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `Employee ${i + 1}`,
    email: `employee${i + 1}@company.example`,
    department: departments[i % departments.length]!,
    salary: 60_000 + (i % 50) * 1_000,
    startDate: new Date(Date.now() - i * 30 * 86_400_000).toISOString().slice(0, 10),
  }));
}

server.tool(
  "list_records",
  "List employee records from the HR database",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe("Number of records to return (default: 500)"),
  },
  async ({ limit = 500 }) => {
    const employees = generateEmployees(limit);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(employees, null, 2) }],
    };
  }
);

// ─── Tool 2: recursive file listing ─────────────────────────────────────────

server.tool(
  "list_files",
  "Recursively list files under a path",
  {
    path: z.string().describe("Directory path to scan"),
    depth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe("Max recursion depth (default: 3)"),
  },
  async ({ path, depth = 3 }) => {
    const entries: Array<{ path: string; type: string; sizeBytes: number; modified: string }> = [];
    const fileCount = Math.pow(8, Math.min(depth, 3)); // scales with depth

    for (let i = 0; i < fileCount; i++) {
      const dir = `${path}/subdir-${Math.floor(i / 8)}`;
      entries.push({
        path: `${dir}/file-${i}.ts`,
        type: "file",
        sizeBytes: 1024 + (i * 137) % 102400,
        modified: new Date(Date.now() - i * 3_600_000).toISOString(),
      });
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }],
    };
  }
);

// ─── Tool 3: application log fetch ──────────────────────────────────────────

const LOG_LEVELS = ["INFO", "WARN", "ERROR", "DEBUG"] as const;

server.tool(
  "fetch_logs",
  "Fetch recent application logs for a service",
  {
    service: z.string().describe("Service name (e.g. api-gateway, auth-service)"),
    lines: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe("Number of log lines (default: 500)"),
    level: z
      .enum(["INFO", "WARN", "ERROR", "DEBUG", "ALL"])
      .optional()
      .describe("Filter by log level (default: ALL)"),
  },
  async ({ service, lines = 500, level = "ALL" }) => {
    const logs = Array.from({ length: lines }, (_, i) => {
      const logLevel = LOG_LEVELS[i % LOG_LEVELS.length]!;
      if (level !== "ALL" && logLevel !== level) return null;
      return {
        timestamp: new Date(Date.now() - i * 1_000).toISOString(),
        level: logLevel,
        service,
        traceId: Math.random().toString(36).slice(2, 18),
        message: `[${service}] Request ${i + 1} processed in ${10 + (i % 200)}ms — status ${i % 20 === 0 ? 500 : 200}`,
      };
    }).filter(Boolean);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(logs, null, 2) }],
    };
  }
);

// ─── Connect ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  "[demo-server] Running. Tools: list_records | list_files | fetch_logs | get_next_page"
);
