from __future__ import annotations

from typing import Literal

import pytest
import sqlparse
from inline_sql_helper.model import FormatOptions
from inline_sql_helper.sqlparse_adapter import (
    SqlFormattingError,
    build_sqlparse_options,
    format_sql,
    split_triple_quote_frame,
)


@pytest.mark.parametrize("keyword_case", ["upper", "lower", "preserve"])
def test_only_approved_sqlparse_options(
    keyword_case: Literal["upper", "lower", "preserve"],
) -> None:
    options = FormatOptions(keyword_case, 2, 88, True)
    mapped = build_sqlparse_options(options, triple_quoted=True)
    assert mapped["strip_comments"] is False
    assert "identifier_case" not in mapped
    assert "truncate_strings" not in mapped
    assert "output_format" not in mapped
    assert ("keyword_case" in mapped) is (keyword_case != "preserve")


def test_preserve_omits_keyword_case() -> None:
    options = FormatOptions("preserve", 2, 88, True)
    mapped = build_sqlparse_options(options, triple_quoted=True)
    assert "keyword_case" not in mapped
    assert mapped["reindent"] is True
    assert mapped["indent_width"] == 2
    assert mapped["wrap_after"] == 88


@pytest.mark.parametrize(
    ("keyword_case", "expected"),
    [("upper", "SELECT 1"), ("lower", "select 1"), ("preserve", "select 1")],
)
def test_short_string_keyword_modes(
    keyword_case: Literal["upper", "lower", "preserve"], expected: str
) -> None:
    assert (
        format_sql(
            "select 1",
            triple_quoted=False,
            options=FormatOptions(keyword_case, 2, 88, True),
        )
        == expected
    )


def test_short_string_rejects_formatter_newline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sqlparse, "format", lambda _sql, **_options: "SELECT\n1")
    with pytest.raises(SqlFormattingError, match="introduced a newline"):
        format_sql(
            "select 1",
            triple_quoted=False,
            options=FormatOptions("upper", 2, 88, True),
        )


@pytest.mark.parametrize("line_ending", ["\n", "\r\n"])
def test_closing_boundary_survives_formatter_dropping_final_newline(
    line_ending: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    content = line_ending + "    select 1" + line_ending + "    "
    monkeypatch.setattr(sqlparse, "format", lambda _sql, **_options: "SELECT 1")

    frame = split_triple_quote_frame(content)
    assert frame.sql_body == "select 1"
    assert frame.trailing_boundary == line_ending + "    "
    assert (
        format_sql(
            content,
            triple_quoted=True,
            options=FormatOptions("upper", 2, 88, True),
        )
        == line_ending + "    SELECT 1" + line_ending + "    "
    )


@pytest.mark.parametrize("content", ["\n    select 1", "\n    select 1\n    "])
def test_formatter_added_final_newline_does_not_change_quote_frame(
    content: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sqlparse, "format", lambda _sql, **_options: "SELECT 1\n")
    expected = "\n    SELECT 1" if content.endswith("1") else "\n    SELECT 1\n    "
    assert (
        format_sql(
            content,
            triple_quoted=True,
            options=FormatOptions("upper", 2, 88, True),
        )
        == expected
    )


@pytest.mark.parametrize(
    ("content", "expected"),
    [("select 1", "SELECT 1"), ("select 1\n", "SELECT 1\n")],
)
def test_formatter_added_newline_matches_exact_short_triple_frame(
    content: str, expected: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sqlparse, "format", lambda _sql, **_options: "SELECT 1\n")
    assert (
        format_sql(
            content,
            triple_quoted=True,
            options=FormatOptions("upper", 2, 88, True),
        )
        == expected
    )


def test_triple_quote_preserves_boundaries_and_outer_indent() -> None:
    content = "\n\n    select a,b from Dataset where x=1 and y=2\n      and z=3\n\n    "
    assert format_sql(
        content,
        triple_quoted=True,
        options=FormatOptions("upper", 2, 88, True),
    ) == (
        "\n\n    SELECT a,b\n    FROM Dataset\n    WHERE x = 1\n"
        "      AND y = 2\n      AND z = 3\n\n    "
    )


@pytest.mark.parametrize("indent_width", [1, 8])
@pytest.mark.parametrize("wrap_after", [20, 500])
def test_triple_quote_indent_and_wrap_options(
    indent_width: int, wrap_after: int
) -> None:
    content = "\n  select a,b from Dataset where x=1 and y=2\n  "
    result = format_sql(
        content,
        triple_quoted=True,
        options=FormatOptions("upper", indent_width, wrap_after, True),
    )
    assert result.startswith("\n  SELECT a,b\n  FROM Dataset\n  WHERE x = 1")
    assert result.endswith("\n  ")
    assert f"\n{' ' * (2 + indent_width)}AND y = 2" in result


@pytest.mark.parametrize("parameter", ["$1", "?", ":name", "%s", "%(name)s"])
def test_comments_identifiers_and_parameters_survive(parameter: str) -> None:
    source = f"select MixedCase, {parameter} -- keep\nfrom TableName"
    result = format_sql(
        source,
        triple_quoted=True,
        options=FormatOptions("upper", 2, 88, True),
    )
    assert "MixedCase" in result
    assert "TableName" in result
    assert parameter in result
    assert "-- keep" in result


def test_triple_quote_keeps_strings_semicolons_and_multiple_statements() -> None:
    source = (
        "\n    select 'a; b' as value from FirstTable;\n"
        '    select "x" from SecondTable\n    '
    )
    assert format_sql(
        source,
        triple_quoted=True,
        options=FormatOptions("upper", 2, 88, True),
    ) == (
        "\n    SELECT 'a; b' AS value\n    FROM FirstTable;\n\n\n"
        '    SELECT "x"\n    FROM SecondTable\n    '
    )


@pytest.mark.parametrize("line_ending", ["\n", "\r\n", "\r"])
def test_split_preserves_multiple_blank_boundaries(line_ending: str) -> None:
    content = (
        line_ending + line_ending + "  select 1" + line_ending + line_ending + "  "
    )
    frame = split_triple_quote_frame(content)
    assert frame.leading_boundary == line_ending + line_ending
    assert frame.trailing_boundary == line_ending + line_ending + "  "
    assert frame.outer_indent == "  "
    assert frame.sql_body == "select 1"
