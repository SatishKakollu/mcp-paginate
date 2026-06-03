# mcp-pager Roadmap

## Current: Option A — Reliable Pagination (v0.x)

The foundation. Make large MCP tool responses reliably usable by LLMs with zero changes to existing tools.

**Status: Shipping**
- ✅ Token-aware chunking (content-aware heuristic + tiktoken subpath)
- ✅ Smart chunking — JSON array at record boundaries, text at line boundaries
- ✅ Agent-readable JSON metadata (`hasMore`, `pageIndex`, `totalPages`, `instruction`)
- ✅ Sliding TTL — cursors survive long LLM sessions
- ✅ HMAC cursor signing for multi-tenant deployments
- ✅ Pluggable backends — MemoryBackend, RedisBackend
- ✅ Observability — `onPaginate` lifecycle events
- ✅ TypeScript + Python (FastMCP) support
- ✅ 92 tests across both languages

---

## Future: Option B — Smart Response Handling (v1.x)

> "Make large tool outputs actually usable by AI agents — not just paginated, but intelligently handled."

This is the longer-term vision. Instead of just chunking responses, mcp-pager becomes a **strategy layer** that picks the best approach per tool and per response.

---

### Architecture: Strategy Pattern

```
Tool response
      ↓
ResponseHandler (new)
      ↓
  Which strategy?
  ├─ Small response      → pass-through (unchanged)
  ├─ Large + list data   → paginate (current behaviour)
  ├─ Large + prose       → summarize  (new)
  ├─ Large + structured  → progressive disclosure (new)
  └─ Custom transformer  → user-defined (new)
```

**API shape (proposed):**

```ts
// TypeScript
paginate(server, {
  maxTokens: 4000,
  strategy: "paginate",         // default — current behaviour
  // strategy: "summarize",     // new
  // strategy: "progressive",   // new
  // strategy: "auto",          // detect best strategy from content
  perTool: {
    "search_docs": { strategy: "summarize", model: "claude-haiku-4-5" },
    "list_files":  { strategy: "paginate" },
    "get_summary": { strategy: "progressive" },
  },
});
```

```python
# Python
paginate(mcp,
  max_tokens=4000,
  strategy="paginate",          # default
  per_tool={
    "search_docs": {"strategy": "summarize", "model": "claude-haiku-4-5"},
    "list_files":  {"strategy": "paginate"},
  }
)
```

---

### Feature 1: Summarization Mode

**What:** When a response is too large, call an LLM to summarize it instead of chunking. Returns a condensed version that fits in one page.

**When to use:** Full data isn't needed — user wants insights, not records. E.g. "What are the main themes in these 10,000 log lines?"

**Architecture:**

```
Tool returns 80k tokens of logs
      ↓
SummarizationHandler
      ↓
Calls summarizer LLM (claude-haiku / gpt-4o-mini — cheap, fast)
      ↓
Returns 2k token summary to the agent
```

**API:**

```ts
import { AnthropicSummarizer } from "mcp-pager/summarizers";

paginate(server, {
  strategy: "summarize",
  summarizer: new AnthropicSummarizer({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: "claude-haiku-4-5",         // cheap model for summarization
    prompt: "Summarize the key points:",
  }),
});
```

**Key decisions:**
- Summarization is **opt-in per tool** — never automatic by default (adds latency + cost)
- Summarizer is a pluggable interface — users can bring any LLM
- The original data is NOT stored — summarization is lossy by design
- Response includes a `summarized: true` flag in metadata so agent knows

**Implementation complexity:** High — needs async LLM call inside the pipeline, error handling for LLM failures, retry logic, cost management

**Dependencies added:** None to core. Optional peer deps: `@anthropic-ai/sdk`, `openai`

---

### Feature 2: Progressive Disclosure

**What:** First response = a lightweight **index** (summary, field list, record count). Subsequent pages = **detail on demand**.

**When to use:** Exploration use cases. E.g. "What tables are in this database?" → agent gets schema overview first, then queries detail on specific tables.

**Flow:**

```
Page 0 (index):
{
  "summary": "500 employee records",
  "fields": ["id", "name", "department", "salary"],
  "totalRecords": 500,
  "hasMore": true,
  "nextCursor": "..."
}

Page 1+ (detail):
[{ "id": 1, "name": "Alice", ... }, ...]
```

**API:**

```ts
paginate(server, {
  perTool: {
    "list_employees": {
      strategy: "progressive",
      indexer: (data) => ({
        summary: `${data.length} employee records`,
        fields: Object.keys(data[0] ?? {}),
        totalRecords: data.length,
      }),
    },
  },
});
```

**Implementation complexity:** Medium — indexer runs synchronously, no LLM needed. Complexity is in the cursor state (index page vs detail pages are different formats).

---

### Feature 3: Structured Output Mode

**What:** Instead of returning raw serialized data, transform each chunk into a cleaner, more token-efficient format before sending to the LLM.

**When to use:** Tools that return noisy data (deeply nested JSON, HTML, XML) where the LLM only needs specific fields.

**Example:**

```ts
paginate(server, {
  perTool: {
    "get_github_issues": {
      strategy: "paginate",
      transform: (record) => ({
        // Return only what the LLM needs, drop the rest
        id: record.number,
        title: record.title,
        status: record.state,
        labels: record.labels.map(l => l.name),
        // Drop: body HTML, reactions, timeline events, etc.
      }),
    },
  },
});
```

**Implementation complexity:** Low-Medium — pure data transformation, no LLM calls. Works on top of existing chunking.

---

### Feature 4: Auto Strategy Selection

**What:** mcp-pager detects the best strategy automatically based on response characteristics.

**Detection rules:**

| Condition | Strategy chosen |
|-----------|----------------|
| Response fits in `maxTokens` | Pass-through |
| Response is a JSON array with identifiable records | Paginate (JSON boundary aware) |
| Response is line-delimited text (logs, CSV) | Paginate (line boundary aware) |
| Response is unstructured prose > 50k tokens | Suggest summarize (warn, don't auto) |
| Response is a single large record | Paginate (char split) |

**Note:** Auto strategy never silently summarizes — summarization always requires explicit opt-in because it's lossy.

---

### Feature 5: Token Optimization Reporting

**What:** Emit metrics on how much token usage was reduced.

```ts
paginate(server, {
  onPaginate: (event) => {
    if (event.type === "chunked") {
      console.log(`Saved ~${event.totalTokens - event.maxTokens} tokens on first response`);
      console.log(`Tool: ${event.toolName} | Pages: ${event.totalChunks}`);
    }
  },
});
```

This already works with the current `onPaginate` callback — no new code needed. Just better documentation and examples.

---

### Feature 6: Hybrid Mode (Pagination + Streaming)

**What:** Stream pages to the LLM as they become available, rather than fetch-all-first. Addresses the core limitation of current mcp-pager.

**Why it's complex:** Requires streaming support in the MCP protocol and the underlying tool. Not all tools can stream. This is a protocol-level change, not just a library change.

**When to build:** After MCP streaming is more widely supported in client implementations.

---

## Migration Path: Option A → Option B

Option B is designed to be **fully backward-compatible** with Option A. All existing `paginate()` calls continue to work — new features are opt-in.

```ts
// v0.x (Option A) — still works in v1.x
paginate(server, { maxTokens: 4000 });

// v1.x (Option B) — new capabilities, same entry point
paginate(server, {
  maxTokens: 4000,
  strategy: "auto",             // new
  perTool: { ... },             // new
  summarizer: new AnthropicSummarizer(...), // new
});
```

---

## Trigger Conditions for Starting Option B

Don't start Option B until:

1. **mcp-pager has real users** — at least 50 npm weekly downloads or 5 GitHub issues filed by external users
2. **The top user request is "I need more than pagination"** — if users are happy with pagination, don't add complexity
3. **TypeScript + Python are both stable** — no outstanding bugs in the core

The research suggests Option B is the right long-term direction. But Option A needs to be solid and adopted first.

---

## Version Plan

| Version | Focus | Key additions |
|---------|-------|--------------|
| v0.6.x | Stability | Smart chunking, Python fix, publish both packages |
| v0.7.x | Hardening | Concurrency tests, edge cases, performance benchmarks |
| v0.8.x | Ecosystem | MCP registry, announcement, documentation polish |
| v1.0.0 | Stable API | Semver commitment, no breaking changes after this |
| v1.1.0 | Option B starts | Structured output + transform API |
| v1.2.0 | Progressive disclosure | Index-first pattern |
| v1.3.0 | Summarization | Optional LLM summarizer with pluggable backends |
| v2.0.0 | Auto strategy | Content-aware strategy selection |
