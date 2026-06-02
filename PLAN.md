# PLAN.md — mcp-paginate

## Goal
Build `mcp-paginate`: a zero-config pagination middleware for MCP servers.  
It wraps any existing MCP server, intercepts tool responses that exceed a configurable token limit, and returns chunked results with cursor-based pagination — transparently, without requiring changes to the underlying server.

---

## Architecture Overview

```
Client (LLM / host)
       │
       ▼
 PaginatingServer (wrapper)          ← mcp-paginate
       │  intercepts tool responses
       │  chunks if over token limit
       │  stores chunks in ChunkStore (in-memory)
       │  returns first page + nextCursor
       ▼
 UnderlyingMcpServer (any server)
```

### Key concepts
- **`paginate(server, options)`** — main export; returns a new MCP server instance with pagination applied.
- **ChunkStore** — in-memory map of `cursor → chunk[]`; entries expire via TTL.
- **Token estimation** — lightweight heuristic (`chars / 4`) by default; user can supply their own counter.
- **Cursor** — opaque base64-encoded string: `{ id, index }`.
- **`get_next_page` synthetic tool** — injected into the tool list so the LLM can fetch subsequent pages.

---

## Deliverables

| # | Item | Status |
|---|------|--------|
| 1 | `package.json` with correct fields, `@modelcontextprotocol/sdk` dep | ✅ |
| 2 | `tsconfig.json` targeting ESM + CJS dual build | ✅ |
| 3 | `src/types.ts` — public options & cursor types | ✅ |
| 4 | `src/chunk-store.ts` — in-memory store with TTL eviction | ✅ |
| 5 | `src/tokenize.ts` — default token estimator + hook | ✅ |
| 6 | `src/paginate.ts` — core wrapper logic | ✅ |
| 7 | `src/index.ts` — public re-exports | ✅ |
| 8 | `vitest.config.ts` + first test suite | ✅ |
| 9 | `README.md` — quickstart + API reference | ✅ |

---

## File Structure (target)

```
mcp-paginate/
├── src/
│   ├── index.ts          # public exports
│   ├── paginate.ts       # paginate() wrapper
│   ├── chunk-store.ts    # TTL-aware in-memory store
│   ├── tokenize.ts       # token counting helpers
│   └── types.ts          # PaginateOptions, Cursor, etc.
├── tests/
│   ├── paginate.test.ts
│   ├── chunk-store.test.ts
│   └── tokenize.test.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── PLAN.md               # this file
└── README.md
```

---

## `paginate(server, options)` API

```ts
interface PaginateOptions {
  maxTokens?: number;          // default: 4000
  ttlMs?: number;              // cursor store TTL, default: 5 * 60 * 1000 (5 min)
  tokenCounter?: (text: string) => number; // default: chars/4 heuristic
  pageToolName?: string;       // default: "get_next_page"
}

function paginate(server: McpServer, options?: PaginateOptions): McpServer;
```

---

## Pagination Flow

1. Client calls any tool on the wrapping server.
2. Wrapper forwards the call to the underlying server and awaits the result.
3. Estimate tokens in the result content.
4. **If under limit** → return result as-is.
5. **If over limit** → split into chunks, store in ChunkStore with a generated ID, return first chunk with a `nextCursor` metadata field.
6. Client calls `get_next_page({ cursor })`.
7. Wrapper looks up cursor in ChunkStore, returns next chunk (and a new `nextCursor` if more remain), or a terminal response when exhausted.
8. Expired cursors return a clear error message.

---

## Constraints & Decisions

- **No external runtime deps** beyond `@modelcontextprotocol/sdk`; `uuid` avoided in favour of `crypto.randomUUID()`.
- **ESM-first** with a CJS fallback via `tsup` dual build.
- **In-memory only** for v1; Redis/persistent store is an extension point via the `ChunkStore` interface.
- Token counting is deliberately approximate (chars/4). Exact tiktoken/claude-tokenizer adds 100 KB+ to the bundle.
- `paginate()` must be non-breaking: if the underlying server changes its tool list, the injected `get_next_page` tool always appears last.

---

## Build & Test Toolchain

| Tool | Purpose |
|------|---------|
| `typescript` | Type-checking + declarations |
| `tsup` | Dual ESM/CJS build |
| `vitest` | Unit + integration tests |
| `@vitest/coverage-v8` | Coverage reporting |

---

## Progress Log

### 2026-06-02 — Initial plan written
- Defined architecture, file layout, public API, and flow.
- No code written yet. Starting scaffold next.

### 2026-06-02 — Scaffold complete (16/16 tests passing, build clean)
- All source files written: `types.ts`, `chunk-store.ts`, `tokenize.ts`, `paginate.ts`, `index.ts`.
- `paginate()` works via a Proxy on `server.tool` — patches every registered tool's handler automatically.
- `ChunkStore` uses `crypto.randomUUID()` and TTL eviction; cursors are base64url-encoded JSON.
- Fixed MCP SDK internals: `_registeredTools` is a plain object (not Map); handler is at `.handler`, called as `handler(args, extra)`.
- Fixed tsup DTS build: added `@types/node` dev dep and `"types": ["node"]` to tsconfig.
- Updated vitest to 4.1.8 to resolve security vulnerability in earlier versions.
- Dual ESM/CJS build succeeds: `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`.
- Remaining: `README.md` quickstart.

### 2026-06-02 — README complete. All 9 deliverables done.
- Covers: how it works, installation, full API table, token counting, `get_next_page` schema, four usage examples, limitations, dev commands.
- Project is scaffold-complete and ready for feature iteration or publish.

### 2026-06-02 — Integration tests added; two real bugs found and fixed
- Added `tests/integration.test.ts`: full MCP Client ↔ Server round-trip via `InMemoryTransport.createLinkedPair()` (actual JSON-RPC protocol, not direct handler calls).
- **Bug 1 fixed:** `get_next_page` was registered AFTER the Proxy, so its own response was being re-paginated recursively — cursor hints got embedded in data chunks. Fix: register `get_next_page` via the original `server.tool` before setting up the Proxy.
- **Bug 2 fixed:** `pageToolName` option was ignored inside `patchArgs` — custom tool names always emitted `get_next_page` in cursor hints. Fix: thread `pageToolName` through `patchArgs` → `maybepaginate`.
- All 26 tests pass (16 unit + 10 integration). Build and typecheck clean.

### 2026-06-02 — v0.2.1: StoreBackend delete(), auto-cleanup, cursor security docs
- Added optional `delete(id)` to `StoreBackend` interface; implemented in `MemoryBackend` and `RedisBackend` (uses `redis.del()`).
- `ChunkStore.get()` now calls `backend.delete?.()` automatically when the last page is served — memory freed immediately, no waiting for TTL.
- Added cursor security section to README: what cursors contain, what they don't, when HMAC signing would be needed.
- Added `ChunkStore` vs `StoreBackend` concept table to README.
- Added `maxTokens` 80% budget recommendation alongside the token counting docs.
- 38 tests passing across 5 files.

---

---

## v0.2 Roadmap (from post-launch review)

| Priority | Item | Notes |
|----------|------|-------|
| 🔴 High | Pluggable store backend (Redis first) | ✅ Done in v0.2.0 |
| 🟠 Med | Better default token counting | ✅ Done in v0.2.0 (tiktoken + Anthropic API examples) |
| 🟠 Med | Real-world examples + demo server | ✅ Done in v0.2.0 (`examples/demo-server.ts`) |
| 🟡 Low-Med | Spec-aligned pagination block | Align with MCP proposal #799 as an opt-in alternative |
| 🟡 Low | Signed/encrypted cursors | Security hardening for shared/multi-tenant environments |
| 🟡 Low | Blog post + community announcement | r/mcp, Hacker News, MCP Discord |

---

_This file is updated at each major milestone._
