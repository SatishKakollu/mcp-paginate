[← Back to overview](../README.md)

# Migration Guide: Manual Pagination → mcp-pager

If you're currently handling large tool responses manually, this guide shows how to replace that code with mcp-pager — typically removing 50–200 lines and making the result more reliable.

---

## Pattern 1: Manual cursor state in the tool

**Before — you manage cursors inside each tool:**

```ts
const cache = new Map<string, { data: unknown[]; expires: number }>();

server.tool(
  "list_records",
  { cursor: z.string().optional(), limit: z.number().default(100) },
  async ({ cursor, limit }) => {
    let records: unknown[];

    if (cursor && cache.has(cursor)) {
      const entry = cache.get(cursor)!;
      if (Date.now() > entry.expires) {
        cache.delete(cursor);
        return { content: [{ type: "text", text: "Cursor expired" }], isError: true };
      }
      records = entry.data;
    } else {
      records = await db.fetchAll(); // fetch everything
      cache.set("session-" + Date.now(), { data: records, expires: Date.now() + 300_000 });
    }

    const start = cursor ? parseInt(cursor) : 0;
    const page = records.slice(start, start + limit);
    const nextCursor = start + limit < records.length ? String(start + limit) : null;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ records: page, nextCursor }),
      }],
    };
  }
);
```

**After — remove all pagination logic, let mcp-pager handle it:**

```ts
import { paginate } from "mcp-pager";

paginate(server, { maxTokens: 4000 });

server.tool("list_records", {}, async () => {
  const records = await db.fetchAll();
  return { content: [{ type: "text", text: JSON.stringify(records) }] };
});
```

Lines removed: ~30. Tools simplified from 2 parameters to 0.

---

## Pattern 2: Manual chunking with offset parameters

**Before — offset/limit baked into tool signature:**

```ts
server.tool(
  "search_documents",
  {
    query: z.string(),
    offset: z.number().default(0),
    limit: z.number().default(50),
  },
  async ({ query, offset, limit }) => {
    const results = await search(query, { offset, limit });
    const total = await countResults(query);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          results,
          offset,
          limit,
          total,
          hasMore: offset + limit < total,
          nextOffset: offset + limit < total ? offset + limit : null,
        }),
      }],
    };
  }
);
```

**After — fetch all, let mcp-pager chunk:**

```ts
import { paginate } from "mcp-pager";

paginate(server, { maxTokens: 4000 });

server.tool("search_documents", { query: z.string() }, async ({ query }) => {
  const results = await searchAll(query); // remove offset/limit
  return { content: [{ type: "text", text: JSON.stringify(results) }] };
});
```

**Trade-off:** mcp-pager fetches all results first. If `searchAll()` is expensive, keep DB-level pagination AND wrap with mcp-pager for safety.

---

## Pattern 3: Wrapping an existing MCP server you don't control

**Before — you can't change the server, so you get truncated responses:**

```ts
// Nothing you can do — the upstream server returns 50k tokens
// and your client chokes on it
```

**After — wrap the upstream server:**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { paginate } from "mcp-pager";

// Proxy all tools from the upstream server through mcp-pager
const proxy = new McpServer({ name: "safe-proxy", version: "1.0.0" });
paginate(proxy, { maxTokens: 4000 });

// Re-register upstream tools on the proxy
proxy.tool("big_tool", {}, async () => {
  const result = await upstreamClient.callTool({ name: "big_tool", arguments: {} });
  return { content: result.content };
});
```

This is mcp-pager's strongest use case — wrapping tools you don't own.

---

## Pattern 4: Python / FastMCP

**Before:**

```python
from mcp.server.fastmcp import FastMCP
import json

mcp = FastMCP("my-server")

_cache = {}

@mcp.tool()
async def list_records(cursor: str = "", limit: int = 100) -> str:
    if cursor and cursor in _cache:
        records = _cache[cursor]
    else:
        records = await db.fetch_all()
        _cache[str(id(records))] = records
    
    start = int(cursor) if cursor else 0
    page = records[start:start + limit]
    next_cursor = str(start + limit) if start + limit < len(records) else ""
    
    return json.dumps({"records": page, "next_cursor": next_cursor})
```

**After:**

```python
from mcp.server.fastmcp import FastMCP
from mcp_pager import paginate
import json

mcp = FastMCP("my-server")
paginate(mcp, max_tokens=4000)

@mcp.tool()
async def list_records() -> str:
    records = await db.fetch_all()
    return json.dumps(records)
```

---

## When NOT to migrate

Keep manual pagination if:

- Your dataset is **very large** (100k+ records) — mcp-pager fetches everything first, which is slow and memory-heavy
- Your tool already has **well-designed cursor parameters** and users call it directly
- You need **real-time data** on each page — mcp-pager snapshots the full result at call time
- You need **filtered pages** — mcp-pager can't re-query with different filters per page

---

## Checklist

```
☐ Install mcp-pager:  npm install mcp-pager  /  pip install mcp-pager
☐ Call paginate() before registering tools
☐ Remove manual cursor/offset parameters from tool signatures
☐ Remove in-process cache/store for pagination state
☐ Test: does the LLM correctly follow get_next_page until hasMore is false?
☐ Set maxTokens to ~80% of your real context budget
☐ For production: use RedisBackend (multi-process safe)
```
