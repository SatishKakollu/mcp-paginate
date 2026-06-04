"""
Real-world MCP server using mcp-pager with actual public APIs.
No API keys required.

APIs:
  - JSONPlaceholder (jsonplaceholder.typicode.com)
  - PokéAPI (pokeapi.co)

Run:
    python examples/real_api_server.py

Test prompts:
    "Fetch all photos and count them by album"
    "Get all Pokémon and list which ones start with 'char'"
    "Fetch all comments and find the most active email address"
"""

import json
import urllib.request
import urllib.parse
from mcp.server.fastmcp import FastMCP
from mcp_pager import paginate

mcp = FastMCP("mcp-pager-real-api")

# One line — all tools are now token-safe
paginate(mcp, max_tokens=4000)


def fetch_json(url: str) -> object:
    with urllib.request.urlopen(url) as response:
        return json.loads(response.read().decode())


# ─── JSONPlaceholder: 5000 photos ────────────────────────────────────────────

@mcp.tool(description="Fetch all photos from JSONPlaceholder (5000 items — large response)")
async def list_photos(album_id: int | None = None) -> str:
    """
    album_id: Filter by album ID (1-100). Omit for all 5000 photos.
    """
    url = "https://jsonplaceholder.typicode.com/photos"
    if album_id:
        url += f"?albumId={album_id}"
    return json.dumps(fetch_json(url), indent=2)


# ─── JSONPlaceholder: 500 comments ───────────────────────────────────────────

@mcp.tool(description="Fetch all comments from JSONPlaceholder (500 items)")
async def list_comments(post_id: int | None = None) -> str:
    """
    post_id: Filter by post ID (1-100). Omit for all 500 comments.
    """
    url = "https://jsonplaceholder.typicode.com/comments"
    if post_id:
        url += f"?postId={post_id}"
    return json.dumps(fetch_json(url), indent=2)


# ─── JSONPlaceholder: 200 todos ───────────────────────────────────────────────

@mcp.tool(description="Fetch all todos from JSONPlaceholder (200 items)")
async def list_todos(user_id: int | None = None) -> str:
    """
    user_id: Filter by user ID (1-10). Omit for all 200 todos.
    """
    url = "https://jsonplaceholder.typicode.com/todos"
    if user_id:
        url += f"?userId={user_id}"
    return json.dumps(fetch_json(url), indent=2)


# ─── PokéAPI: 1300+ Pokémon ──────────────────────────────────────────────────

@mcp.tool(description="Fetch Pokémon list from PokéAPI (up to 1500 Pokémon)")
async def list_pokemon(limit: int = 300, offset: int = 0) -> str:
    """
    limit: Number of Pokémon to fetch (default 300, max 1500)
    offset: Starting offset (default 0)
    """
    url = f"https://pokeapi.co/api/v2/pokemon?limit={limit}&offset={offset}"
    data = fetch_json(url)
    return json.dumps({
        "total": data["count"],
        "fetched": len(data["results"]),
        "offset": offset,
        "pokemon": data["results"],
    }, indent=2)


# ─── PokéAPI: Single Pokémon detail (very large response) ────────────────────

@mcp.tool(description="Get full detail for a single Pokémon including all moves (large response)")
async def get_pokemon_detail(name: str) -> str:
    """
    name: Pokémon name or ID (e.g. 'charizard' or '6')
    """
    url = f"https://pokeapi.co/api/v2/pokemon/{name.lower()}"
    return json.dumps(fetch_json(url), indent=2)


if __name__ == "__main__":
    mcp.run()
