/**
 * Real-world MCP server using mcp-pager with actual public APIs.
 * No API keys required.
 *
 * APIs used:
 *  - JSONPlaceholder (jsonplaceholder.typicode.com) — fake but realistic data
 *  - PokéAPI (pokeapi.co) — 1300+ Pokémon
 *
 * Run:
 *   npx tsx examples/real-api-server.ts
 *
 * Test prompts for Claude Desktop:
 *   "Fetch all photos from JSONPlaceholder and count them by album"
 *   "Get all Pokémon and list which ones are over 100kg"
 *   "Fetch all comments and find the most active email address"
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { paginate } from "../src/index.js";

const server = new McpServer({ name: "mcp-pager-real-api", version: "0.6.0" });

// One line — all tools below are now token-safe
paginate(server, { maxTokens: 4000 });

// ─── JSONPlaceholder: 5000 photos ────────────────────────────────────────────

server.tool(
  "list_photos",
  "Fetch all photos from JSONPlaceholder (5000 items — large response)",
  {
    albumId: z.number().int().min(1).max(100).optional()
      .describe("Filter by album ID (1-100). Omit for all 5000 photos."),
  },
  async ({ albumId }) => {
    const url = albumId
      ? `https://jsonplaceholder.typicode.com/photos?albumId=${albumId}`
      : "https://jsonplaceholder.typicode.com/photos";

    const res = await fetch(url);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const photos = await res.json();

    return {
      content: [{ type: "text" as const, text: JSON.stringify(photos, null, 2) }],
    };
  }
);

// ─── JSONPlaceholder: 500 comments ───────────────────────────────────────────

server.tool(
  "list_comments",
  "Fetch all comments from JSONPlaceholder (500 items)",
  {
    postId: z.number().int().min(1).max(100).optional()
      .describe("Filter by post ID (1-100). Omit for all 500 comments."),
  },
  async ({ postId }) => {
    const url = postId
      ? `https://jsonplaceholder.typicode.com/comments?postId=${postId}`
      : "https://jsonplaceholder.typicode.com/comments";

    const res = await fetch(url);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const comments = await res.json();

    return {
      content: [{ type: "text" as const, text: JSON.stringify(comments, null, 2) }],
    };
  }
);

// ─── JSONPlaceholder: 200 todos ───────────────────────────────────────────────

server.tool(
  "list_todos",
  "Fetch all todos from JSONPlaceholder (200 items)",
  {
    userId: z.number().int().min(1).max(10).optional()
      .describe("Filter by user ID (1-10). Omit for all todos."),
    completed: z.boolean().optional()
      .describe("Filter by completion status"),
  },
  async ({ userId, completed }) => {
    let url = "https://jsonplaceholder.typicode.com/todos";
    const params = new URLSearchParams();
    if (userId) params.set("userId", String(userId));
    if (completed !== undefined) params.set("completed", String(completed));
    if (params.toString()) url += `?${params}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const todos = await res.json();

    return {
      content: [{ type: "text" as const, text: JSON.stringify(todos, null, 2) }],
    };
  }
);

// ─── PokéAPI: 1300+ Pokémon ──────────────────────────────────────────────────

server.tool(
  "list_pokemon",
  "Fetch Pokémon from PokéAPI — returns name, URL, and basic stats",
  {
    limit: z.number().int().min(1).max(1500).default(300)
      .describe("Number of Pokémon to fetch (default: 300, max: 1500)"),
    offset: z.number().int().min(0).default(0)
      .describe("Starting offset (default: 0)"),
  },
  async ({ limit, offset }) => {
    const res = await fetch(
      `https://pokeapi.co/api/v2/pokemon?limit=${limit}&offset=${offset}`
    );
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json() as { count: number; results: unknown[] };

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          total: data.count,
          fetched: data.results.length,
          offset,
          pokemon: data.results,
        }, null, 2),
      }],
    };
  }
);

// ─── PokéAPI: Pokémon detail with moves (very large) ─────────────────────────

server.tool(
  "get_pokemon_detail",
  "Get detailed info for a single Pokémon including all moves (large response)",
  {
    name: z.string().describe("Pokémon name or ID (e.g. 'charizard', '6')"),
  },
  async ({ name }) => {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${name.toLowerCase()}`);
    if (!res.ok) throw new Error(`Pokémon '${name}' not found`);
    const pokemon = await res.json();

    return {
      content: [{ type: "text" as const, text: JSON.stringify(pokemon, null, 2) }],
    };
  }
);

// ─── Connect ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  "[real-api-server] Running. Tools: list_photos | list_comments | list_todos | list_pokemon | get_pokemon_detail"
);
