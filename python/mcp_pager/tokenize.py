"""
Token counting for mcp-pager.

Default: uses tiktoken (cl100k_base) if installed, otherwise falls back
to a content-aware heuristic. Install tiktoken for best accuracy:

    pip install "mcp-pager[tiktoken]"
"""
from __future__ import annotations
import json
from typing import Any

_tiktoken_enc = None
_tiktoken_checked = False


def default_token_counter(text: str) -> int:
    """
    Token counter that auto-uses tiktoken when available, falls back to
    a content-aware heuristic (±10% for English/JSON).
    """
    global _tiktoken_enc, _tiktoken_checked

    if not _tiktoken_checked:
        _tiktoken_checked = True
        try:
            import tiktoken
            _tiktoken_enc = tiktoken.get_encoding("cl100k_base")
        except ImportError:
            pass

    if _tiktoken_enc is not None:
        return len(_tiktoken_enc.encode(text))

    return _heuristic_counter(text)


def _heuristic_counter(text: str) -> int:
    """Content-aware fallback: CJK, whitespace, punctuation each weighted."""
    tokens = 0.0
    i = 0
    while i < len(text):
        cp = ord(text[i])

        if (0x4E00 <= cp <= 0x9FFF or  # CJK Unified Ideographs
                0xAC00 <= cp <= 0xD7AF or  # Hangul
                0x3040 <= cp <= 0x30FF):   # Hiragana/Katakana
            tokens += 0.67  # ~1.5 chars per token
            i += 1

        elif text[i] in " \t\n\r":
            tokens += 0.15  # whitespace merges into adjacent tokens
            i += 1

        elif text[i].isdigit():
            j = i
            while j < len(text) and text[j].isdigit():
                j += 1
            tokens += (j - i) / 3  # digits group ~3 per token
            i = j

        elif text[i] in "{}[]\"'():,;.!?<>=+-*/\\|@#$%^&~`":
            tokens += 0.5  # structural/punctuation: ~2 chars per token
            i += 1

        else:
            tokens += 0.25  # regular ASCII: ~4 chars per token
            i += 1

    return max(1, int(tokens) + (1 if tokens % 1 > 0 else 0))


def estimate_content_tokens(content: Any, counter: callable) -> int:
    return counter(json.dumps(content, default=str))
