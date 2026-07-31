"""Small, layout-preserving adapter around the vendored sqlparse package."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, cast

import sqlparse
from sqlparse import sql as sqltypes
from sqlparse.tokens import Keyword, Punctuation

from inline_sql_helper.model import FormatOptions


class SqlFormattingError(ValueError):
    """A source-free sqlparse adapter failure."""


@dataclass(frozen=True, slots=True)
class TripleQuoteFrame:
    """The quote-content boundaries and dedented SQL body."""

    leading_boundary: str
    trailing_boundary: str
    outer_indent: str
    sql_body: str


def build_sqlparse_options(
    options: FormatOptions,
    *,
    triple_quoted: bool,
) -> dict[str, object]:
    """Map the public settings to the deliberately small sqlparse surface."""

    mapped: dict[str, object] = {
        "reindent": triple_quoted,
        "strip_comments": False,
        "use_space_around_operators": options.use_space_around_operators,
    }
    if options.keyword_case != "preserve":
        mapped["keyword_case"] = options.keyword_case
    if triple_quoted:
        mapped["indent_width"] = options.indent_width
        mapped["wrap_after"] = options.wrap_after
    return mapped


def _is_blank(line: str) -> bool:
    return line.strip(" \t\r\n") == ""


def _common_outer_indent(lines: list[str]) -> str:
    indents = [
        line[: len(line) - len(line.lstrip(" \t"))]
        for line in lines
        if not _is_blank(line)
    ]
    if not indents:
        return ""
    common = indents[0]
    for indent in indents[1:]:
        length = 0
        for left, right in zip(common, indent, strict=False):
            if left != right:
                break
            length += 1
        common = common[:length]
        if not common:
            break
    return common


def split_triple_quote_frame(content: str) -> TripleQuoteFrame:
    """Separate blank boundaries and one common outer indentation."""

    lines = content.splitlines(keepends=True)
    leading: list[str] = []
    while lines and _is_blank(lines[0]):
        leading.append(lines.pop(0))

    trailing: list[str] = []
    while lines and _is_blank(lines[-1]):
        trailing.insert(0, lines.pop())

    # The final SQL line owns its line terminator.  Moving that terminator to
    # the trailing frame keeps it byte-for-byte even when sqlparse drops it.
    if lines:
        final_line = lines[-1]
        for line_ending in ("\r\n", "\n", "\r"):
            if final_line.endswith(line_ending):
                lines[-1] = final_line[: -len(line_ending)]
                trailing.insert(0, line_ending)
                break

    outer_indent = _common_outer_indent(lines)
    body = "".join(
        line[len(outer_indent) :] if not _is_blank(line) else line for line in lines
    )
    return TripleQuoteFrame(
        leading_boundary="".join(leading),
        trailing_boundary="".join(trailing),
        outer_indent=outer_indent,
        sql_body=body,
    )


def _format_with_sqlparse(sql: str, options: dict[str, object]) -> str:
    try:
        return sqlparse.format(sql, **cast(dict[str, Any], options))
    except Exception:
        # Never include the protected candidate or a third-party diagnostic in
        # the process-facing error.  The caller reports only a stable reason.
        raise SqlFormattingError("sqlparse formatting failed") from None


_SELECT_LIST_STOP_KEYWORDS = frozenset(
    {
        "FROM",
        "INTO",
        "WHERE",
        "GROUP",
        "ORDER",
        "HAVING",
        "LIMIT",
        "OFFSET",
        "WINDOW",
        "UNION",
        "EXCEPT",
        "INTERSECT",
        "FOR",
    }
)


def _expand_identifier_list(list_token: sqltypes.IdentifierList, indent: str) -> str:
    """Flatten one top-level column list onto one line per column."""
    parts: list[str] = []
    current: list[str] = []
    for token in list_token.tokens:
        if token.ttype is Punctuation and token.value == ",":
            parts.append("".join(str(item) for item in current).strip())
            current = []
        else:
            current.append(token)
    parts.append("".join(str(item) for item in current).strip())
    return f",\n{indent}".join(parts)


def expand_select_lists(statement: sqltypes.Statement, indent: str) -> str:
    """Expand SELECT column lists in place, one column per line."""
    tokens = statement.tokens
    pieces: list[str] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if not (token.ttype is Keyword.DML and token.value.upper() == "SELECT"):
            pieces.append(str(token))
            index += 1
            continue
        cursor = index + 1
        while cursor < len(tokens) and tokens[cursor].is_whitespace:
            cursor += 1
        if cursor >= len(tokens) or not isinstance(
            tokens[cursor], sqltypes.IdentifierList
        ):
            pieces.append(str(token))
            index += 1
            continue
        pieces.append(f"SELECT\n{indent}")
        pieces.append(_expand_identifier_list(tokens[cursor], indent))
        index = cursor + 1
        while index < len(tokens) and tokens[index].is_whitespace:
            index += 1
        pieces.append("\n")
    return "".join(pieces)


def expand_select_lists_in_text(sql_text: str, indent: str) -> str:
    """Expand every SELECT column list in a formatted SQL body."""
    statements = sqlparse.parse(sql_text)
    return "".join(expand_select_lists(statement, indent) for statement in statements)


def format_sql(
    protected_sql: str,
    *,
    triple_quoted: bool,
    options: FormatOptions,
) -> str:
    """Format protected SQL while retaining its Python string quote frame."""

    mapped = build_sqlparse_options(options, triple_quoted=triple_quoted)
    if not triple_quoted:
        result = _format_with_sqlparse(protected_sql, mapped)
        if "\r" in result or "\n" in result:
            raise SqlFormattingError("short-string formatting introduced a newline")
        return result

    frame = split_triple_quote_frame(protected_sql)
    formatted = _format_with_sqlparse(frame.sql_body, mapped)
    # The body deliberately excludes the closing-boundary line ending.  A
    # formatter may nevertheless append one; discard terminal line endings so
    # the original boundary remains the sole owner of that text.
    formatted = formatted.rstrip("\r\n")
    if options.expand_select_list:
        formatted = expand_select_lists_in_text(formatted, " " * options.indent_width)
    indented = "".join(
        frame.outer_indent + line if not _is_blank(line) else line
        for line in formatted.splitlines(keepends=True)
    )
    return frame.leading_boundary + indented + frame.trailing_boundary
