# mcp-pager

**Token-aware response management for [MCP](https://modelcontextprotocol.io) servers.**

Your tools return thousands of records. LLMs have token limits. **mcp-pager sits between them** — it intercepts oversized tool responses, chunks them by token count, and delivers each page with agent-readable metadata so the LLM knows exactly what to fetch next. One line of code. No changes to your existing server.

---

## Choose your language

| | TypeScript / JavaScript | Python |
|--|------------------------|--------|
| **Install** | `npm install mcp-pager` | `pip install mcp-pager` |
| **Docs** | [TypeScript guide →](docs/typescript.md) | [Python guide →](python/README.md) |
| **Registry** | [npmjs.com/package/mcp-pager](https://www.npmjs.com/package/mcp-pager) | [pypi.org/project/mcp-pager](https://pypi.org/project/mcp-pager) |
| **MCP SDK** | `@modelcontextprotocol/sdk` | `mcp` (FastMCP) |

---

## What it does

```
Tool call  →  mcp-pager  →  Your MCP server
                 │
           token count ≤ limit?
           ├─ yes → return as-is
           └─ no  → chunk → store → return page 1 + metadata

get_next_page(cursor) → read from store → return next chunk + metadata
```

When a response is too large, the LLM receives structured metadata it can act on directly:

```json
{
  "hasMore": true,
  "pageIndex": 0,
  "totalPages": 22,
  "remainingPages": 21,
  "nextCursor": "eyJpZCI6Ijkx...",
  "instruction": "Call `get_next_page` with nextCursor to get the next page. Repeat until hasMore is false."
}
```

---

## Key features

| Feature | Description |
|---------|-------------|
| **Zero config** | One line wraps your entire server |
| **One backend call** | Your API is called once regardless of how many pages the LLM fetches |
| **Sliding TTL** | Cursor expiry resets on every page fetch — long sessions never time out mid-way |
| **Redis backend** | Production-ready shared storage for multi-process / serverless deployments |
| **HMAC signing** | Optional cursor signing for multi-tenant environments |
| **Observability** | `onPaginate` / `on_paginate` callback with typed lifecycle events |
| **Agent-readable metadata** | Structured JSON tells the LLM exactly what to do next |

---

## Documentation

| Doc | Description |
|-----|-------------|
| [TypeScript guide](docs/typescript.md) | Full API, backends, signing, observability |
| [Python guide](python/README.md) | Full API, FastMCP integration, backends |
| [Migration guide](docs/migration.md) | Moving from manual pagination to mcp-pager |
| [Token savings](docs/token-savings.md) | Before/after numbers with real examples |
| [Roadmap](ROADMAP.md) | What's coming in v1.x (Smart Response Handling) |

## Source

```
mcp-pager/
├── src/              TypeScript source
├── docs/             Guides and documentation
├── python/
│   ├── mcp_pager/    Python source
│   └── README.md     Full Python documentation
└── examples/         Demo servers (TS + Python)
```

---

## License

MIT — [Satish Kakollu](https://github.com/SatishKakollu)
