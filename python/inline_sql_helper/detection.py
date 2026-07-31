"""Source-level SQL candidate detection for Python string syntax units."""

from dataclasses import dataclass
from typing import Literal

from inline_sql_helper.literals import SupportedLiteral, UnsupportedLiteral
from inline_sql_helper.positions import SourceMap, SourceSpan


@dataclass(frozen=True, slots=True)
class SqlDetection:
    """One source-level SQL detection result."""

    matched: bool
    marker_span: SourceSpan | None
    sql_span: SourceSpan | None
    reason: Literal["marker", "keyword", "none"]


_MARKERS = frozenset({"-- sql", "--sql"})
_KEYWORDS = (
    "select",
    "with",
    "insert",
    "update",
    "delete",
    "merge",
    "create",
    "alter",
    "drop",
    "truncate",
    "explain",
)
_ASCII_WHITESPACE = frozenset(" \t\r\n")


def _continues_identifier(character: str) -> bool:
    """Return whether *character* continues a Python/Unicode identifier."""
    return bool(character) and (character == "_" or ("A" + character).isidentifier())


def _detect_source_slice(text: str, base: int) -> SqlDetection:
    """Detect an explicit marker or leading SQL keyword in one source slice."""
    cursor = 0
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\r\n")
        if body.strip(" \t") == "":
            cursor += len(line)
            continue
        if body.strip(" \t").casefold() in _MARKERS:
            marker = SourceSpan(base + cursor, base + cursor + len(body))
            return SqlDetection(
                True,
                marker,
                SourceSpan(base + cursor + len(line), base + len(text)),
                "marker",
            )
        break

    significant = 0
    while significant < len(text) and text[significant] in _ASCII_WHITESPACE:
        significant += 1
    folded = text[significant:].casefold()
    for keyword in _KEYWORDS:
        if not folded.startswith(keyword):
            continue
        following = text[significant + len(keyword) : significant + len(keyword) + 1]
        if not _continues_identifier(following):
            return SqlDetection(
                True,
                None,
                SourceSpan(base + significant, base + len(text)),
                "keyword",
            )
    return SqlDetection(False, None, None, "none")


def detect_sql(
    literal: SupportedLiteral | UnsupportedLiteral,
    source_map: SourceMap,
) -> SqlDetection:
    """Detect SQL from physical source characters without evaluating escapes."""
    span = (
        literal.content_span
        if isinstance(literal, SupportedLiteral)
        else literal.detection_content_span
    )
    if span is None:
        return SqlDetection(False, None, None, "none")
    return _detect_source_slice(source_map.slice(span), span.start)
