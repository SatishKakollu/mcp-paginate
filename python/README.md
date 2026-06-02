# mcp-pager (Python)

Token-aware response paging for MCP servers. One line of code — large tool responses chunked and delivered page by page with agent-readable metadata.

```bash
pip install mcp-pager
```

```python
from mcp.server.fastmcp import FastMCP
from mcp_pager import paginate

mcp = FastMCP("my-server")
paginate(mcp, max_tokens=4000)

@mcp.tool()
async def list_records(limit: int = 500) -> str:
    records = await db.fetch(limit=limit)  # could be huge
    return json.dumps(records)
```

See [github.com/SatishKakollu/mcp-pager](https://github.com/SatishKakollu/mcp-pager) for full documentation.
