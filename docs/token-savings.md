[← Back to overview](../README.md)

# Before vs After: Token Savings with mcp-pager

Real numbers from the demo server tools. All measurements use the default `chars/4` token estimator.

---

## Scenario 1: HR Records (500 employees)

```
Tool: list_records(limit=500)
Response size: ~180,000 tokens
Context window: 32,000 tokens (Claude Sonnet)
```

| | Without mcp-pager | With mcp-pager |
|--|------------------|----------------|
| Tokens sent in first response | 180,000 → **truncated** | **4,000** |
| LLM receives complete data | ❌ No | ✅ Yes (22 pages) |
| Backend API calls | 1 | 1 |
| Tokens used total (all pages) | —  | 22 × 4,000 = **88,000** |
| Data integrity | ❌ Corrupted mid-record | ✅ Each page is valid JSON |

**Result:** LLM gets all 500 records across 22 pages. First page arrives in milliseconds. Each chunk is a valid JSON array — no broken records.

---

## Scenario 2: Log Fetch (1,000 lines)

```
Tool: fetch_logs(service="api-gateway", lines=1000)
Response size: ~95,000 tokens
```

| | Without mcp-pager | With mcp-pager |
|--|------------------|----------------|
| First response tokens | 95,000 → **error** | **4,000** |
| Session expires mid-way | N/A | ❌ Old: yes (fixed TTL) / ✅ Now: no (sliding TTL) |
| Log lines per chunk | — | ~160 complete lines |
| Lines split across pages | N/A | **0** (line-boundary splitting) |

---

## Scenario 3: File Listing (512 files, depth=3)

```
Tool: list_files(path="/var/app", depth=3)
Response size: ~45,000 tokens
```

| | Without mcp-pager | With mcp-pager |
|--|------------------|----------------|
| Tokens in first response | 45,000 | **4,000** |
| Pages needed | — | **11** |
| Files per page | — | ~46 complete file entries |

---

## Summary

| Response size | Pages needed | First response | LLM gets full data |
|--------------|-------------|----------------|-------------------|
| < 4,000 tokens | 1 (pass-through) | Full response | ✅ Yes |
| 4,000–40,000 | 2–10 | First 4k tokens | ✅ Yes |
| 40,000–200,000 | 10–50 | First 4k tokens | ✅ Yes |
| 200,000+ | 50+ | First 4k tokens | ✅ Yes (may be slow) |
| 200,000+ (recommended) | — | — | Use tool-level pagination |

---

## Token budget recommendation

Set `maxTokens` to **80% of your context budget** to absorb token counting variance:

| Model | Context window | Recommended `maxTokens` |
|-------|---------------|------------------------|
| Claude Sonnet 4.6 | 200,000 | 160,000 |
| Claude Haiku 4.5 | 200,000 | 160,000 |
| GPT-4o | 128,000 | 100,000 |
| GPT-4o-mini | 128,000 | 100,000 |
| Cursor (default) | 32,000 | 25,000 |

> **Note:** These are generous limits. For tool responses specifically, you'll want to leave room for the conversation history and system prompt — a `maxTokens` of 4,000–8,000 is typical.
