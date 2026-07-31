"""Source-positioned Python tokenization and string-token grouping."""

import io
import token
import tokenize
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from inline_sql_helper.positions import SourceMap, SourceSpan


class UnsupportedStringSyntax(ValueError):
    """The token cannot be split into one supported literal."""


@dataclass(frozen=True, slots=True)
class SourceToken:
    """One Python token with an exact code-point source span."""

    token_type: int
    exact_type: int
    text: str
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class StringTokenBundle:
    """One top-level plain, formatted, or template string token unit."""

    kind: Literal["string", "fstring", "tstring"]
    span: SourceSpan
    tokens: tuple[SourceToken, ...]


def tokenize_source(
    source: str,
    source_map: SourceMap,
) -> tuple[SourceToken, ...]:
    """Return source-positioned Python tokens."""
    result: list[SourceToken] = []
    for item in tokenize.generate_tokens(io.StringIO(source).readline):
        if item.type == tokenize.ENDMARKER or (
            item.string == ""
            and item.type
            in {
                tokenize.NEWLINE,
                tokenize.NL,
                tokenize.INDENT,
                tokenize.DEDENT,
            }
        ):
            continue
        result.append(
            SourceToken(
                token_type=item.type,
                exact_type=item.exact_type,
                text=item.string,
                span=SourceSpan(
                    source_map.offset_from_token(*item.start),
                    source_map.offset_from_token(*item.end),
                ),
            )
        )
    return tuple(result)


def _token_constant(name: str) -> int | None:
    value = getattr(token, name, None)
    return value if isinstance(value, int) else None


def scan_string_bundles(
    tokens: Sequence[SourceToken],
) -> tuple[StringTokenBundle, ...]:
    """Group top-level plain, formatted, and template string token units."""
    start_to_end = {
        start: end
        for start_name, end_name in (
            ("FSTRING_START", "FSTRING_END"),
            ("TSTRING_START", "TSTRING_END"),
        )
        if (start := _token_constant(start_name)) is not None
        and (end := _token_constant(end_name)) is not None
    }
    fstring_start = _token_constant("FSTRING_START")
    result: list[StringTokenBundle] = []
    index = 0
    while index < len(tokens):
        current = tokens[index]
        if current.token_type == tokenize.STRING:
            result.append(StringTokenBundle("string", current.span, (current,)))
            index += 1
            continue
        if current.token_type not in start_to_end:
            index += 1
            continue
        start = index
        expected_ends: list[int] = []
        while index < len(tokens):
            item = tokens[index]
            if item.token_type in start_to_end:
                expected_ends.append(start_to_end[item.token_type])
            elif expected_ends and item.token_type == expected_ends[-1]:
                expected_ends.pop()
                if not expected_ends:
                    index += 1
                    break
            index += 1
        if expected_ends:
            raise UnsupportedStringSyntax("unterminated string token bundle")
        grouped = tuple(tokens[start:index])
        kind: Literal["fstring", "tstring"] = (
            "fstring" if current.token_type == fstring_start else "tstring"
        )
        result.append(
            StringTokenBundle(
                kind,
                SourceSpan(grouped[0].span.start, grouped[-1].span.end),
                grouped,
            )
        )
    return tuple(result)
