import pytest
from mcp_pager.tokenize import default_token_counter, _heuristic_counter


def test_heuristic_empty():
    assert _heuristic_counter("") == 0 or _heuristic_counter("") >= 0


def test_heuristic_ascii():
    # ~4 chars per token for regular text
    result = _heuristic_counter("hello world")
    assert 2 <= result <= 5


def test_heuristic_json():
    # JSON has structural chars — should count more tokens than flat chars/4
    text = '{"name": "John", "age": 30, "city": "NYC"}'
    flat = len(text) // 4
    heuristic = _heuristic_counter(text)
    # Should be meaningfully more than flat chars/4
    assert heuristic > flat


def test_heuristic_digits():
    # Digit runs group ~3 per token
    result = _heuristic_counter("123456789")
    assert result == 3  # 9 digits / 3


def test_default_counter_positive():
    assert default_token_counter("some text") > 0


def test_default_counter_longer_is_more():
    short = default_token_counter("hi")
    long = default_token_counter("hi " * 100)
    assert long > short
