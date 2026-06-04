/**
 * Edge case test server for Claude Desktop.
 * Each tool is designed to exercise a specific edge case.
 *
 * Run: npx tsx examples/edge-case-server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { paginate } from "../src/index.js";

const server = new McpServer({ name: "edge-case-server", version: "0.8.0" });

paginate(server, {
  maxTokens: 200,
  ttlMs: 30_000, // 30s TTL for expiry test
  signingSecret: "test-secret-12345",
  onPaginate: (event) => {
    if (event.type === "chunked") {
      console.error(`[PAGINATE] chunked: ${event.toolName} → ${event.totalChunks} pages (${event.totalTokens} tokens)`);
    }
    if (event.type === "page_fetched") {
      console.error(`[PAGINATE] page_fetched: ${event.pageIndex + 1}/${event.totalPages} hasMore=${event.hasMore}`);
    }
    if (event.type === "cursor_expired") {
      console.error(`[PAGINATE] cursor_expired`);
    }
  },
});

// ─── EC-1: Small response — should pass through unchanged ────────────────────
server.tool(
  "ec_small_response",
  "EC-1: Returns a small response (under token limit). Should NOT paginate.",
  {},
  async () => ({
    content: [{ type: "text" as const, text: JSON.stringify({ message: "This is small", items: [1, 2, 3] }) }],
  })
);

// ─── EC-2: Exactly at limit ───────────────────────────────────────────────────
server.tool(
  "ec_at_limit",
  "EC-2: Returns a response right at the token limit. Should pass through without pagination.",
  {},
  async () => ({
    content: [{ type: "text" as const, text: "x".repeat(780) }], // ~200 tokens with JSON overhead
  })
);

// ─── EC-3: Large JSON array — record boundary split ───────────────────────────
server.tool(
  "ec_json_array",
  "EC-3: Returns a large JSON array. Each page should be valid JSON with complete records.",
  { count: z.number().int().min(10).max(200).default(100) },
  async ({ count }) => {
    const records = Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      name: `Record ${i + 1}`,
      description: `This is a detailed description for record ${i + 1} with extra text to make it larger`,
      tags: ["alpha", "beta", "gamma"],
      score: Math.random(),
    }));
    return { content: [{ type: "text" as const, text: JSON.stringify(records, null, 2) }] };
  }
);

// ─── EC-4: Nested object (Pokémon-style) ─────────────────────────────────────
server.tool(
  "ec_nested_object",
  "EC-4: Returns a large nested object (not an array). Tests nested array splitting.",
  {},
  async () => {
    const data = {
      id: 1,
      name: "test-entity",
      metadata: { created: new Date().toISOString(), version: "1.0" },
      events: Array.from({ length: 80 }, (_, i) => ({
        id: i + 1,
        type: ["click", "view", "purchase", "scroll"][i % 4],
        timestamp: new Date(Date.now() - i * 60000).toISOString(),
        payload: { userId: `user-${i % 10}`, value: Math.random() * 100 },
      })),
      metrics: Array.from({ length: 20 }, (_, i) => ({
        name: `metric-${i}`,
        value: Math.random(),
      })),
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// ─── EC-5: Log lines — line boundary split ────────────────────────────────────
server.tool(
  "ec_log_lines",
  "EC-5: Returns log lines. Each page should contain complete log entries (no split mid-line).",
  { lines: z.number().int().min(50).max(500).default(200) },
  async ({ lines }) => {
    const levels = ["INFO", "WARN", "ERROR", "DEBUG"];
    const logs = Array.from({ length: lines }, (_, i) =>
      `${new Date(Date.now() - i * 1000).toISOString()} [${levels[i % 4]}] service-api Request ${i + 1} completed in ${10 + (i % 200)}ms status=${i % 20 === 0 ? 500 : 200} traceId=abc${i}`
    ).join("\n");
    return { content: [{ type: "text" as const, text: logs }] };
  }
);

// ─── EC-6: Very large single page (stress test) ───────────────────────────────
server.tool(
  "ec_stress_test",
  "EC-6: Returns a very large response creating 50+ pages. Tests memory and loop stability.",
  {},
  async () => {
    const records = Array.from({ length: 500 }, (_, i) => ({
      id: i + 1,
      data: `item-${i}-` + "x".repeat(50),
    }));
    return { content: [{ type: "text" as const, text: JSON.stringify(records, null, 2) }] };
  }
);

// ─── EC-7: Empty response ─────────────────────────────────────────────────────
server.tool(
  "ec_empty",
  "EC-7: Returns an empty array. Should pass through with no pagination envelope.",
  {},
  async () => ({
    content: [{ type: "text" as const, text: "[]" }],
  })
);

// ─── EC-8: Short TTL expiry test ──────────────────────────────────────────────
server.tool(
  "ec_short_ttl",
  "EC-8: Returns paginated data. The cursor expires in 10 seconds — test expiry by waiting before get_next_page.",
  {},
  async () => {
    const records = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, value: `item-${i}` }));
    return { content: [{ type: "text" as const, text: JSON.stringify(records, null, 2) }] };
  }
);

// ─── EC-9: Concurrent sessions ───────────────────────────────────────────────
server.tool(
  "ec_session_a",
  "EC-9a: Call this AND ec_session_b simultaneously to test session isolation.",
  {},
  async () => ({
    content: [{ type: "text" as const, text: JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ session: "A", id: i })), null, 2) }],
  })
);

server.tool(
  "ec_session_b",
  "EC-9b: Call this AND ec_session_a simultaneously to test session isolation.",
  {},
  async () => ({
    content: [{ type: "text" as const, text: JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ session: "B", id: i })), null, 2) }],
  })
);

// ─── EC-10: Mixed content types ───────────────────────────────────────────────
server.tool(
  "ec_mixed_content",
  "EC-10: Returns mixed markdown + JSON + plain text in one response.",
  {},
  async () => {
    const lines = [
      "# Report Title",
      "Generated at: " + new Date().toISOString(),
      "",
      "## Summary",
      "- Total records: 100",
      "- Status: OK",
      "",
      "## Data",
      "```json",
      JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ id: i, val: `v${i}` })), null, 2),
      "```",
      "",
      "## Notes",
      ...Array.from({ length: 50 }, (_, i) => `Line ${i + 1}: Some note about item ${i + 1} that has enough text to fill space`),
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[edge-case-server] Ready. Tools: EC-1 through EC-10`);
