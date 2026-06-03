# Announcement Posts

## r/mcp post

**Title:** mcp-pager — zero-config response paging for MCP servers (TypeScript + Python)

---

If you've ever had an MCP tool return 50,000 tokens of data and watched your LLM choke, truncate, or just give up — this is for you.

**mcp-pager** wraps any existing MCP server and automatically handles oversized tool responses. One line of code, no changes to your tools.

```ts
// TypeScript
import { paginate } from "mcp-pager";
paginate(server, { maxTokens: 4000 });
// That's it. Every tool you register is now safe.
```

```python
# Python (FastMCP)
from mcp_pager import paginate
paginate(mcp, max_tokens=4000)
```

**How it works:**
- Tool returns a huge response → mcp-pager intercepts
- Splits into chunks, stores in memory (or Redis for production)
- Returns page 1 + structured metadata the LLM can act on
- LLM calls `get_next_page` until `hasMore` is false
- Your backend is called **exactly once** regardless of how many pages

**The metadata the LLM gets:**
```json
{
  "hasMore": true,
  "pageIndex": 0,
  "totalPages": 22,
  "remainingPages": 21,
  "nextCursor": "eyJpZCI6...",
  "instruction": "Call get_next_page with nextCursor. Repeat until hasMore is false."
}
```

**What's included:**
- Smart chunking — JSON arrays split at record boundaries (valid JSON every page), logs split at line boundaries
- Sliding TTL — cursors survive long LLM sessions (fixed the mid-session expiry bug)
- Redis backend for production/multi-process deployments
- HMAC cursor signing for multi-tenant environments
- `onPaginate` events for logging/metrics
- 92 tests across TypeScript and Python

**Install:**
```bash
npm install mcp-pager        # TypeScript
pip install mcp-pager        # Python
```

**Links:**
- GitHub: https://github.com/SatishKakollu/mcp-pager
- npm: https://npmjs.com/package/mcp-pager
- PyPI: https://pypi.org/project/mcp-pager

Happy to answer questions. Feedback welcome — especially on LLM reliability in your specific setup.

---

## Hacker News (Show HN) post

**Title:** Show HN: mcp-pager – automatic response pagination for MCP servers

---

I built mcp-pager to solve a specific pain point: MCP tools that return large datasets overflow LLM context windows, and fixing it usually means rewriting the tool with manual cursor logic.

mcp-pager wraps the server at the middleware level — one `paginate(server)` call before you register tools, and every tool response that exceeds your token limit is automatically chunked and delivered page by page with structured metadata the LLM can follow.

Key design decisions worth discussing:

**Fetch-all-first.** The tool is called once and the full response is stored, then chunked. This means it's not suitable for truly massive datasets (100k+ records) but it handles the common case (moderately large API responses, DB queries, file listings) without requiring changes to the underlying tool.

**Smart chunking.** JSON arrays split at record boundaries (each chunk is valid JSON), line-based text splits at newlines. Falls back to character splitting for anything else.

**Sliding TTL.** Cursor expiry resets on every successful page fetch. This fixes a real bug I hit: with 50 pages and LLM latency of ~10s/page, a fixed 5-minute TTL expired mid-session.

**Python + TypeScript.** Both are published. The Python version wraps FastMCP and required working around FastMCP 1.27's new structured output schema validation (which rejected our `list[TextContent]` responses — fixed by clearing `fn_metadata.output_schema` after tool registration).

GitHub: https://github.com/SatishKakollu/mcp-pager

---

## MCP Discord message

Hey all — I just published **mcp-pager**, a zero-config pagination middleware for MCP servers.

If you've had tools returning responses too large for the LLM's context window, this is a one-line fix:

```ts
paginate(server, { maxTokens: 4000 });
```

Works with any existing McpServer (TypeScript) or FastMCP (Python). Smart chunking keeps JSON arrays as valid JSON per page, logs split at line boundaries. Redis backend available for production deployments.

npm: `npm install mcp-pager`
pip: `pip install mcp-pager`
GitHub: https://github.com/SatishKakollu/mcp-pager

Would love feedback on how well it works with your LLM client setup — especially on the multi-turn cursor following reliability.
