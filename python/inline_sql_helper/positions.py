"""Conversions between Python parser, tokenizer, and VS Code source positions."""

import re
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from typing import Self

from inline_sql_helper.model import Position, TextRange


class PositionMappingError(ValueError):
    """A source position is outside a representable code-point boundary."""


@dataclass(frozen=True, order=True, slots=True)
class SourceSpan:
    """A half-open source offset span measured in Python code points."""

    start: int
    end: int

    def __post_init__(self) -> None:
        if self.start < 0 or self.end < self.start:
            raise ValueError("invalid source span")


@dataclass(frozen=True, slots=True)
class _LineMap:
    """Boundary tables for one physical source line, excluding its terminator."""

    start: int
    content_end: int
    next_start: int
    utf8_at_codepoint: tuple[int, ...]
    utf16_at_codepoint: tuple[int, ...]


def _line_map(text: str, start: int, content_end: int, next_start: int) -> _LineMap:
    utf8 = [0]
    utf16 = [0]
    for character in text[start:content_end]:
        utf8.append(utf8[-1] + len(character.encode("utf-8")))
        utf16.append(utf16[-1] + len(character.encode("utf-16-le")) // 2)
    return _LineMap(start, content_end, next_start, tuple(utf8), tuple(utf16))


def _exact_index(boundaries: tuple[int, ...], value: int) -> int:
    index = bisect_left(boundaries, value)
    if index == len(boundaries) or boundaries[index] != value:
        raise PositionMappingError("column is not a code-point boundary")
    return index


@dataclass(frozen=True, slots=True)
class SourceMap:
    """Immutable source map with exact UTF-8 and UTF-16 boundary conversions."""

    text: str
    lines: tuple[_LineMap, ...]
    line_starts: tuple[int, ...]

    @classmethod
    def from_text(cls, text: str) -> Self:
        """Build physical-line boundary tables for *text*."""
        lines: list[_LineMap] = []
        start = 0
        for match in re.finditer(r"\r\n|\r|\n", text):
            lines.append(_line_map(text, start, match.start(), match.end()))
            start = match.end()
        lines.append(_line_map(text, start, len(text), len(text)))
        frozen_lines = tuple(lines)
        return cls(
            text=text,
            lines=frozen_lines,
            line_starts=tuple(line.start for line in frozen_lines),
        )

    def _line(self, index: int) -> _LineMap:
        if index < 0 or index >= len(self.lines):
            raise PositionMappingError("line is outside the document")
        return self.lines[index]

    def slice(self, span: SourceSpan) -> str:
        """Return the text in *span*, rejecting an end outside this document."""
        if span.end > len(self.text):
            raise PositionMappingError("span is outside the document")
        return self.text[span.start : span.end]

    def offset_from_ast(self, lineno: int, utf8_col: int) -> int:
        """Convert a one-based AST line and UTF-8 byte column to an offset."""
        line = self._line(lineno - 1)
        return line.start + _exact_index(line.utf8_at_codepoint, utf8_col)

    def offset_from_token(self, row: int, codepoint_col: int) -> int:
        """Convert a one-based tokenizer row and physical code-point column."""
        line = self._line(row - 1)
        maximum = line.next_start - line.start
        if codepoint_col < 0 or codepoint_col > maximum:
            raise PositionMappingError("token column is outside the physical line")
        return line.start + codepoint_col

    def offset_from_vscode(self, line: int, utf16_col: int) -> int:
        """Convert a zero-based VS Code line and UTF-16 column to an offset."""
        record = self._line(line)
        return record.start + _exact_index(record.utf16_at_codepoint, utf16_col)

    def vscode_from_offset(self, offset: int) -> Position:
        """Convert a source offset to a strict zero-based VS Code position."""
        if offset < 0 or offset > len(self.text):
            raise PositionMappingError("offset is outside the document")
        line_index = max(0, bisect_right(self.line_starts, offset) - 1)
        record = self.lines[line_index]
        if offset > record.content_end:
            raise PositionMappingError("offset is inside a line terminator")
        codepoint_col = offset - record.start
        return Position(line_index, record.utf16_at_codepoint[codepoint_col])

    def vscode_range(self, span: SourceSpan) -> TextRange:
        """Convert a source span to a half-open VS Code range."""
        return TextRange(
            start=self.vscode_from_offset(span.start),
            end=self.vscode_from_offset(span.end),
        )

    def vscode_boundaries(self) -> tuple[int, ...]:
        """Return every source offset that can be represented by VS Code."""
        return tuple(
            offset
            for line in self.lines
            for offset in range(line.start, line.content_end + 1)
        )
