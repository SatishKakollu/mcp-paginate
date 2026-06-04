[← Back to overview](../README.md)

# LLM Prompting Guide for mcp-pager

Copy-paste prompts tested with Claude, GPT-4o, and Cursor.

---

## System prompt (add once — works for all models)

```
When a tool response contains pagination metadata (hasMore, nextCursor),
you MUST retrieve all pages before answering the user. Call get_next_page
with the nextCursor value and repeat until hasMore is false. Never answer
from partial results.
```

Add this to your Claude Desktop config, Cursor rules, or system prompt.

---

## Model-specific prompts

### Claude (Sonnet / Opus)
Works reliably with the base system prompt above. No extra instructions needed.

### GPT-4o
Add this if Claude's prompt isn't enough:
```
Important: if a tool returns {"hasMore": true, "nextCursor": "..."}, 
you MUST call get_next_page(cursor) immediately. Keep calling until 
hasMore is false. Do NOT summarize or answer until you have ALL pages.
```

### Cursor / smaller models
Embed in every user message that needs complete data:
```
[After calling the tool, if hasMore is true, keep calling 
get_next_page until hasMore is false before responding]
```

---

## Verified conversation flow

This is what a correct pagination session looks like.
Use this to verify your setup is working.

**User prompt:**
```
List all employee records using list_records(limit=500). 
Page through everything until hasMore is false, then tell me 
the total count and department breakdown.
```

**Expected LLM behavior:**
```
Turn 1: calls list_records(limit=500)
         → receives page 1/22, hasMore=true

Turn 2: calls get_next_page(cursor="eyJpZ...1")
         → receives page 2/22, hasMore=true

... (repeats) ...

Turn 22: calls get_next_page(cursor="eyJpZ...21")
          → receives page 22/22, hasMore=false

Turn 23: answers user with complete data
```

**Red flags — LLM is NOT paginating correctly:**
- Answers after page 1 without calling get_next_page
- Says "I retrieved X records" but X < total
- Calls get_next_page with the wrong cursor or no cursor
- Stops paginating before hasMore is false

---

## Claude Desktop setup

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "your-server": {
      "command": "...",
      "args": [...]
    }
  }
}
```

For system prompt, create a Project in Claude Desktop and add the system prompt there — it applies to all chats in that project.

---

## Cursor setup

Add to `.cursor/rules` or your global Cursor rules:

```
# MCP Pagination
When any MCP tool response contains hasMore: true and a nextCursor field,
always call get_next_page with that cursor before processing results.
Repeat until hasMore is false.
```

---

## Tested results

| Model | System prompt needed | Reliability |
|-------|---------------------|-------------|
| Claude Sonnet 4.6 | Base prompt | ✅ Reliable |
| Claude Opus 4.8 | Base prompt | ✅ Reliable |
| GPT-4o | Extended prompt | ✅ Reliable with extra instruction |
| GPT-4o-mini | Extended prompt | ⚠️ Occasional early stops |
| Cursor (Claude backend) | Base prompt | ✅ Reliable |

---

## If the LLM stops early

If the LLM answers before fetching all pages, add this to your user message:

```
Important: you MUST call get_next_page repeatedly until hasMore is false
before giving me the answer. Do not stop early.
```

Or increase the forcefulness of the instruction field by passing a custom
`pageToolName` description when calling `paginate()`.
