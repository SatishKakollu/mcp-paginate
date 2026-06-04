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

// ─── Edge case 1: Nested arrays ──────────────────────────────────────────────
// Each post embeds its own comments array — deeply nested structure.
// Tests whether smart chunking handles records containing sub-arrays.

server.tool(
  "list_posts_with_comments",
  "Fetch all posts with their comments embedded — nested array per record (edge case)",
  {},
  async () => {
    const [posts, comments] = await Promise.all([
      fetch("https://jsonplaceholder.typicode.com/posts").then(r => r.json()) as Promise<Array<{ id: number; [k: string]: unknown }>>,
      fetch("https://jsonplaceholder.typicode.com/comments").then(r => r.json()) as Promise<Array<{ postId: number; [k: string]: unknown }>>,
    ]);

    // Embed comments into each post — creates deeply nested records
    const enriched = posts.map(post => ({
      ...post,
      comments: comments.filter(c => c.postId === post.id),
    }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify(enriched, null, 2) }],
    };
  }
);

// ─── Edge case 2: Single massive object (not an array) ───────────────────────
// Returns ONE Pokémon with 500+ moves, 10+ abilities, full sprite set.
// Tests the char-split fallback when content is a single large object.
// Charizard has ~500 moves — the full detail is ~80,000 tokens.

server.tool(
  "get_pokemon_full_detail",
  "Get COMPLETE detail for a Pokémon — all moves, abilities, sprites, stats (single large object edge case)",
  {
    name: z.string().default("charizard")
      .describe("Pokémon name. Try 'charizard', 'mewtwo', 'pikachu'"),
  },
  async ({ name }) => {
    const [pokemon, species] = await Promise.all([
      fetch(`https://pokeapi.co/api/v2/pokemon/${name.toLowerCase()}`).then(r => {
        if (!r.ok) throw new Error(`Not found: ${name}`);
        return r.json();
      }),
      fetch(`https://pokeapi.co/api/v2/pokemon-species/${name.toLowerCase()}`).then(r =>
        r.ok ? r.json() : null
      ),
    ]);

    // Merge everything — produces a very large single object
    const full = { ...pokemon, species };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(full, null, 2) }],
    };
  }
);

// ─── Edge case 3: Wrapped JSON object (not a bare array) ─────────────────────
// Returns { total, page, results: [...] } — the array is NOT at the top level.
// Tests that tryJsonArraySplit handles wrapper objects by falling through
// to line-split or char-split.

server.tool(
  "search_users",
  "Search JSONPlaceholder users — returns wrapped object { total, results } (not a bare array)",
  {},
  async () => {
    const users = await fetch("https://jsonplaceholder.typicode.com/users").then(r => r.json()) as unknown[];

    // Wrap in an object — this is NOT a bare JSON array
    const wrapped = {
      total: users.length,
      page: 1,
      results: users,
      metadata: {
        source: "jsonplaceholder.typicode.com",
        fetched_at: new Date().toISOString(),
      },
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// ─── Edge case 4: Mixed text + structured data ────────────────────────────────
// Returns a markdown report with embedded JSON blocks.
// Tests line-split on content that is neither pure JSON nor pure plain text.

server.tool(
  "get_api_report",
  "Generate a report mixing markdown text and JSON data (mixed content edge case)",
  {},
  async () => {
    const [posts, users] = await Promise.all([
      fetch("https://jsonplaceholder.typicode.com/posts").then(r => r.json()) as Promise<unknown[]>,
      fetch("https://jsonplaceholder.typicode.com/users").then(r => r.json()) as Promise<unknown[]>,
    ]);

    // Mix markdown + JSON — tests line-boundary splitting on mixed content
    const report = [
      "# JSONPlaceholder API Report",
      `Generated: ${new Date().toISOString()}`,
      "",
      "## Summary",
      `- Total posts: ${(posts as unknown[]).length}`,
      `- Total users: ${(users as unknown[]).length}`,
      "",
      "## Users",
      "```json",
      JSON.stringify(users, null, 2),
      "```",
      "",
      "## Posts (first 10)",
      "```json",
      JSON.stringify((posts as unknown[]).slice(0, 10), null, 2),
      "```",
      "",
      "## All Posts",
      ...((posts as unknown[]).map((p: unknown) =>
        `- Post ${(p as { id: number }).id}: ${(p as { title: string }).title}`
      )),
    ].join("\n");

    return {
      content: [{ type: "text" as const, text: report }],
    };
  }
);

// ─── Edge case 5: Empty response ─────────────────────────────────────────────
// Returns an empty array — should pass through without triggering pagination.

server.tool(
  "list_empty",
  "Returns an empty array — tests that mcp-pager passes through small/empty responses unchanged",
  {},
  async () => {
    return {
      content: [{ type: "text" as const, text: JSON.stringify([], null, 2) }],
    };
  }
);

// ─── Connect ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error([
  "[real-api-server] Running.",
  "Standard: list_photos | list_comments | list_todos | list_pokemon | get_pokemon_detail",
  "Edge cases: list_posts_with_comments | get_pokemon_full_detail | search_users | get_api_report | list_empty",
].join("\n"));
