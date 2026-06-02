# mcp-paginate

Zero-config pagination middleware for [MCP](https://modelcontextprotocol.io) servers.

Wrap any existing MCP server with one call. Tool responses that exceed your token limit are automatically chunked and returned with cursor-based pagination — no changes required to your underlying server.

```ts
import { paginate } from "mcp-paginate";

const server = new McpServer({ name: "my-server", version: "1.0.0" });
paginate(server, { maxTokens: 4000 });

// Register tools as normal — pagination is applied transparently.
server.tool("search", { query: z.string() }, async ({ query }) => {
  const results = await db.search(query); // could be huge
  return { content: [{ type: "text", text: JSON.stringify(results) }] };
});
```

---

## How it works

1. `paginate()` wraps `server.tool` via a Proxy so every tool you register gets a paginating handler automatically.
2. When a tool returns a response, its token count is estimated.
3. **Under the limit** → response is returned as-is; no overhead.
4. **Over the limit** → the response is split into chunks, stored with a TTL, and the first chunk is returned along with a `nextCursor`.
5. The LLM calls the injected `get_next_page` tool with the cursor to retrieve subsequent pages.
6. The final page has no cursor — the LLM knows it has all the data.

```
Tool call  →  PaginatingServer  →  UnderlyingServer
                    │
              token count ≤ limit?
              ├─ yes → return as-is
              └─ no  → chunk → store → return page 1 + cursor

get_next_page(cursor) → read from store (NO backend call) → return next chunk
```

---

## Key design strength: one backend call, always

**No matter how many pages the LLM fetches, your backend is called exactly once.**

```
list_records() called once  →  backend returns 500 records
                                        ↓
                             mcp-paginate splits into 22 chunks
                             stores all chunks in ChunkStore
                                        ↓
                             page 1 returned to LLM + cursor

get_next_page() × 21  →  memory reads only, zero backend calls
```

This is the opposite of traditional API pagination (like `?page=2&per_page=100`) where every page is a new database or network request. mcp-paginate fetches everything once and serves it in pieces — your backend sees a single request regardless of how many pages the LLM retrieves.

**The tradeoff:** the full response is held in memory until the session completes (via `delete()` on last page) or TTL expires. For large datasets this matters — see [Limitations](#limitations) below.

---

## Installation

```bash
npm install mcp-paginate
```

**Peer requirement:** `@modelcontextprotocol/sdk` ≥ 1.0.0 (already in your project).

---

## API

### `paginate(server, options?)`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `server` | `McpServer` | — | The MCP server to wrap |
| `options.maxTokens` | `number` | `4000` | Max tokens per page |
| `options.ttlMs` | `number` | `300000` | Cursor TTL in ms (5 min) |
| `options.tokenCounter` | `(text: string) => number` | `chars / 4` | Custom token counter |
| `options.pageToolName` | `string` | `"get_next_page"` | Name of the injected pagination tool |
| `options.store` | `StoreBackend` | `MemoryBackend` | Custom storage backend (e.g. Redis) |

Returns the same `McpServer` instance (mutates in-place for composability).

---

## Concepts: `ChunkStore` vs `StoreBackend`

| Term | What it is | Who uses it |
|------|-----------|-------------|
| **`ChunkStore`** | Internal coordinator — handles cursor encoding, chunk splitting, and TTL. You never instantiate this directly. | Used internally by `paginate()` |
| **`StoreBackend`** | The interface you implement (or pick from the built-ins) to control *where* chunks are physically stored. | You implement this for custom stores |

`paginate(server, { store: myBackend })` is the only integration point you need.

---

## Storage backends

### Default: in-memory

Works out of the box. Chunks live in process memory with TTL eviction. **Not suitable for multi-process or serverless deployments** — each process has its own isolated store.

```ts
import { paginate } from "mcp-paginate";

paginate(server); // uses MemoryBackend by default
```

### Redis (production)

Chunks survive restarts and are shared across processes. Requires [`ioredis`](https://github.com/redis/ioredis):

```bash
npm install ioredis
```

```ts
import Redis from "ioredis";
import { paginate } from "mcp-paginate";
import { RedisBackend } from "mcp-paginate/redis";

const redis = new Redis(process.env.REDIS_URL);

paginate(server, {
  store: new RedisBackend(redis),
  ttlMs: 10 * 60 * 1000, // 10 min — Redis enforces this via SETEX
});
```

`RedisBackend` accepts an optional second argument to namespace keys (default: `"mcp-paginate:"`):

```ts
new RedisBackend(redis, "myapp:pages:")
```

### Custom backend

Implement the `StoreBackend` interface to use any store (DynamoDB, Postgres, Upstash, etc.).

The three methods:
- `get(id)` — return chunks or `null` if missing/expired
- `set(id, chunks, ttlMs)` — persist chunks; enforce TTL however the store supports it
- `delete(id)` *(optional)* — called automatically when the last page of a session is served, so you can free the entry immediately rather than waiting for TTL expiry

```ts
import type { StoreBackend } from "mcp-paginate";

class DynamoBackend implements StoreBackend {
  async get(id: string): Promise<string[] | null> {
    const item = await dynamo.get({ TableName: "pages", Key: { id } }).promise();
    if (!item.Item || Date.now() > item.Item.ttl * 1000) return null;
    return item.Item.chunks as string[];
  }

  async set(id: string, chunks: string[], ttlMs: number): Promise<void> {
    await dynamo.put({
      TableName: "pages",
      Item: { id, chunks, ttl: Math.floor((Date.now() + ttlMs) / 1000) },
    }).promise();
  }
}

paginate(server, { store: new DynamoBackend() });
```

---

## Cursor security

Cursors are **base64url-encoded `{id, index}` pairs** — they contain no user data and can be safely logged or inspected. The actual chunks live server-side in the store.

What this means in practice:

| Concern | Status |
|---------|--------|
| Cursor contains sensitive data | No — only an opaque pointer |
| Cursor can be forged to access other sessions | No — IDs are `crypto.randomUUID()`, effectively unguessable |
| Cursor can be replayed after expiry | No — TTL is enforced by the backend |
| Cursors are signed / tamper-proof | **No** — a client can craft a cursor pointing to an arbitrary `{id, index}`. If the `id` doesn't exist in the store, `get_next_page` returns an error. No data leakage, but also no cryptographic integrity check. |

For shared multi-tenant environments where clients must not be able to probe arbitrary IDs, add HMAC signing on top of the base64url encoding. This is not built-in and is not needed for single-tenant or trusted-client deployments.

---

## Token counting

### Default: `chars / 4` heuristic

`Math.ceil(text.length / 4)` — accurate to ±15% for typical English and JSON. Fast, no dependencies.

> **Recommendation:** Set `maxTokens` to ~80% of your actual context budget to absorb heuristic variance. For a 4 096-token context, use `maxTokens: 3200`. For an 8 192-token context, use `maxTokens: 6500`.

### tiktoken (OpenAI-compatible, exact)

```bash
npm install @dqbd/tiktoken
```

```ts
import { get_encoding } from "@dqbd/tiktoken";
import { paginate } from "mcp-paginate";

const enc = get_encoding("cl100k_base"); // GPT-4 / Claude approximation

paginate(server, {
  maxTokens: 4000,
  tokenCounter: (text) => enc.encode(text).length,
});
```

### Anthropic token count API (exact, async-wrapped)

For Claude deployments where exact Claude tokenization matters:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { paginate } from "mcp-paginate";

const anthropic = new Anthropic();

// Cache the last count to avoid per-chunk API calls
let cachedCount = { text: "", tokens: 0 };

paginate(server, {
  maxTokens: 4000,
  tokenCounter: (text) => {
    // Synchronous approximation with async correction on large payloads.
    // For a fully async counter, use the store backend pattern instead.
    if (text === cachedCount.text) return cachedCount.tokens;
    const approx = Math.ceil(text.length / 4);
    // Fire-and-forget to warm the cache for the next call.
    anthropic.messages
      .countTokens({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: text }] })
      .then((r) => { cachedCount = { text, tokens: r.input_tokens }; })
      .catch(() => {});
    return approx;
  },
});
```

> **Tip:** For Claude, the `chars / 4` default is usually close enough. Claude's tokenizer averages ~3.5–4 chars/token for English and ~4–5 for JSON.

---

### `get_next_page` tool

`mcp-paginate` injects this tool automatically. The LLM calls it when a response contains a cursor:

**Input schema:**
```json
{ "cursor": "<opaque string returned by previous call>" }
```

**Success response:** next page content, with another cursor if more pages remain.

**Error response** (expired / invalid cursor):
```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "Cursor not found or expired. Please re-invoke the original tool." }]
}
```

Cursors are base64url-encoded opaque pointers — they contain no user data.

---

## Usage examples

### Minimal setup

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { paginate } from "mcp-paginate";
import { z } from "zod";

const server = new McpServer({ name: "my-server", version: "1.0.0" });

paginate(server); // one line, zero config

server.tool("list_files", { dir: z.string() }, async ({ dir }) => {
  const files = await fs.readdir(dir, { recursive: true });
  return { content: [{ type: "text", text: files.join("\n") }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Production setup with Redis

```ts
import Redis from "ioredis";
import { paginate } from "mcp-paginate";
import { RedisBackend } from "mcp-paginate/redis";

const redis = new Redis(process.env.REDIS_URL);

paginate(server, {
  maxTokens: 4000,
  ttlMs: 10 * 60 * 1000,
  store: new RedisBackend(redis),
});
```

### Custom token budget, TTL, and tool name

```ts
paginate(server, {
  maxTokens: 2000,          // tighter budget for smaller context windows
  ttlMs: 60_000,            // cursors expire after 1 minute
  pageToolName: "next_chunk", // avoid collision with existing tools
});
```

### Run the demo server

A working demo with three realistic tools (HR records, file listing, log fetch):

```bash
npx tsx examples/demo-server.ts
```

Connect any MCP client and call `list_records`, `list_files`, or `fetch_logs`. Each will paginate automatically when results exceed the token budget.

---

## Limitations

### Fetch-all-first — not designed for very large datasets

mcp-paginate fetches the **complete response from your tool in one shot**, then chunks it. For small-to-moderate payloads (thousands of records, a few MB) this is fine. For very large datasets it has consequences:

| Dataset size | Behaviour |
|-------------|-----------|
| < ~5 000 records | Works well — fast fetch, low memory |
| 5 000 – 50 000 records | Works but first call is slow; memory holds entire result |
| 50 000+ records | Not recommended — use tool-level pagination instead |

**The right fix for large datasets** is to add `limit` and `cursor` parameters directly to the tool so the backend paginates at the source:

```ts
server.tool(
  "list_records",
  { limit: z.number().default(100), cursor: z.string().optional() },
  async ({ limit, cursor }) => {
    const offset = cursor ? parseInt(atob(cursor)) : 0;
    const rows = await db.query("SELECT * FROM t LIMIT ? OFFSET ?", [limit, offset]);
    const nextCursor = rows.length === limit ? btoa(String(offset + limit)) : null;
    return { content: [{ type: "text", text: JSON.stringify({ rows, nextCursor }) }] };
  }
);
```

Use mcp-paginate as a **retrofit for tools you don't control** or tools that weren't designed with pagination in mind — not as a substitute for proper DB-level pagination when you own the data layer.

---

### When a tool already describes its own pagination

If a tool's description says it supports pagination (e.g. "accepts a cursor parameter, returns nextCursor in the response"), mcp-paginate still works — but the behaviour depends on response size:

**Case 1 — Tool returns a small page (under `maxTokens`):**
mcp-paginate passes it through unchanged. The LLM reads the tool's own `nextCursor` from the JSON response and calls the tool again directly. No conflict — mcp-paginate is invisible.

```
LLM calls list_records(cursor=null)  →  small page returned as-is
LLM reads nextCursor from JSON       →  calls list_records(cursor="abc") directly
```

**Case 2 — Tool returns a large page (over `maxTokens`):**
mcp-paginate will chunk the oversized response and inject its own cursor. The LLM now sees *two* pagination signals — the tool's native `nextCursor` inside the chunked JSON and mcp-paginate's `get_next_page` cursor. This causes confusion.

**Recommendation:** for tools that already handle their own pagination and return predictably-sized pages, exclude them from wrapping or raise `maxTokens` high enough that their pages never trigger chunking:

```ts
// Wrap the server but set a high limit so natively-paginated tools pass through
paginate(server, { maxTokens: 50_000 });

// Or skip paginate() entirely for servers where all tools are already paginated
```

---

### Other limitations

- **Approximate token counting.** The default `chars / 4` heuristic is accurate to ±15%. Use tiktoken or the Anthropic API for exact counts. Set `maxTokens` to ~80% of your real budget to absorb variance.
- **Single-server scope.** Each `paginate()` call has its own isolated store. Use a shared Redis backend for multi-process or serverless deployments.
- **Memory bounded by response size.** The full tool response is held in the store until the last page is served (auto-deleted) or TTL expires. Monitor memory if tools can return very large payloads.

---

## Development

```bash
npm install
npm test               # run tests (35 tests across 5 files)
npm run test:watch     # watch mode
npm run typecheck      # tsc type check
npm run build          # ESM + CJS build → dist/index.* + dist/redis.*
npm run test:coverage  # v8 coverage report
```

---

## License

MIT
