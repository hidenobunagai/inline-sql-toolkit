"""Source-positioned Python tokenization and string-token grouping."""

import io
import token
import tokenize
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from inline_sql_helper.positions import PositionMappingError, SourceMap, SourceSpan


class UnsupportedStringSyntax(ValueError):
    """The token cannot be split into one supported literal."""


class UnsafeFieldScan(ValueError):
    """A source-free failure to identify exact f-string fields."""


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
    tokenizer_line_starts = [0]
    tokenizer_line_starts.extend(
        index + 1 for index, character in enumerate(source) if character == "\n"
    )

    def offset(row: int, column: int) -> int:
        """Map tokenize's LF-only rows, falling back for lone CR in strings."""
        try:
            return source_map.offset_from_token(row, column)
        except PositionMappingError:
            if row < 1 or row > len(tokenizer_line_starts):
                raise
            result = tokenizer_line_starts[row - 1] + column
            if result < 0 or result > len(source):
                raise
            return result

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
                    offset(*item.start),
                    offset(*item.end),
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


def scan_fstring_field_spans(
    bundle: StringTokenBundle,
    source_map: SourceMap,
) -> tuple[SourceSpan, ...]:
    """Return complete top-level replacement fields, including braces."""
    del source_map
    fstring_start = _token_constant("FSTRING_START")
    fstring_end = _token_constant("FSTRING_END")
    if bundle.kind != "fstring" or fstring_start is None or fstring_end is None:
        raise UnsafeFieldScan("invalid f-string bundle")
    fields: list[SourceSpan] = []
    field_start: int | None = None
    closers: list[tuple[int, int]] = []
    fstring_depth = 0
    outer_started = False
    outer_ended = False
    opening = {
        token.LPAR: token.RPAR,
        token.LSQB: token.RSQB,
        token.LBRACE: token.RBRACE,
    }
    closing = frozenset(opening.values())
    for item in bundle.tokens:
        if item.token_type == fstring_start:
            if outer_ended or (outer_started and field_start is None):
                raise UnsafeFieldScan("invalid f-string token state")
            outer_started = True
            fstring_depth += 1
            continue
        if item.token_type == fstring_end:
            if not outer_started or outer_ended or fstring_depth == 0:
                raise UnsafeFieldScan("invalid f-string token state")
            fstring_depth -= 1
            if fstring_depth == 0:
                outer_ended = True
            continue
        if not outer_started or outer_ended:
            raise UnsafeFieldScan("invalid f-string token state")
        if field_start is None:
            if fstring_depth == 1 and item.exact_type == token.LBRACE:
                field_start = item.span.start
                closers = [(token.RBRACE, fstring_depth)]
            continue
        expected = opening.get(item.exact_type)
        if expected is not None:
            closers.append((expected, fstring_depth))
        elif item.exact_type in closing:
            if (
                not closers
                or item.exact_type != closers[-1][0]
                or fstring_depth != closers[-1][1]
            ):
                raise UnsafeFieldScan("unbalanced replacement field")
            closers.pop()
            if not closers:
                fields.append(SourceSpan(field_start, item.span.end))
                field_start = None
    if field_start is not None or fstring_depth != 0:
        raise UnsafeFieldScan("unterminated f-string field")
    if not outer_started or not outer_ended:
        raise UnsafeFieldScan("invalid f-string token state")
    return tuple(fields)
