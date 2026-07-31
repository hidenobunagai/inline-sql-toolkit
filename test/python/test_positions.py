import ast
from collections.abc import Callable

import pytest
from hypothesis import given
from hypothesis import strategies as st
from inline_sql_helper.model import Position, TextRange
from inline_sql_helper.positions import (
    PositionMappingError,
    SourceMap,
    SourceSpan,
)


@pytest.mark.parametrize(
    ("text", "offset", "expected"),
    [
        ("abc", 3, Position(0, 3)),
        ("日本", 1, Position(0, 1)),
        ("😀x", 1, Position(0, 2)),
        ("𝔘x", 1, Position(0, 2)),
        ("e\u0301", 2, Position(0, 2)),
        ("a\r\n😀", 3, Position(1, 0)),
    ],
)
def test_vscode_positions(text: str, offset: int, expected: Position) -> None:
    """Catch interpreting Unicode columns as Python code-point columns."""
    source_map = SourceMap.from_text(text)
    assert source_map.vscode_from_offset(offset) == expected
    assert source_map.offset_from_vscode(expected.line, expected.character) == offset


@pytest.mark.parametrize(
    ("text", "boundaries", "positions"),
    [
        (
            "a\nb",
            (0, 1, 2, 3),
            (Position(0, 0), Position(0, 1), Position(1, 0), Position(1, 1)),
        ),
        (
            "a\rb",
            (0, 1, 2, 3),
            (Position(0, 0), Position(0, 1), Position(1, 0), Position(1, 1)),
        ),
        (
            "a\r\nb",
            (0, 1, 3, 4),
            (Position(0, 0), Position(0, 1), Position(1, 0), Position(1, 1)),
        ),
        ("a\n", (0, 1, 2), (Position(0, 0), Position(0, 1), Position(1, 0))),
    ],
)
def test_vscode_boundaries_cover_each_physical_line_boundary(
    text: str,
    boundaries: tuple[int, ...],
    positions: tuple[Position, ...],
) -> None:
    """Catch lost final lines and treating CRLF's interior as a VS Code position."""
    source_map = SourceMap.from_text(text)
    assert source_map.vscode_boundaries() == boundaries
    assert (
        tuple(source_map.vscode_from_offset(offset) for offset in boundaries)
        == positions
    )


def test_span_slice_and_range_are_half_open() -> None:
    """Catch inclusive spans or UTF-16 ranges derived from code-point columns."""
    source_map = SourceMap.from_text("😀日本\n")
    span = SourceSpan(1, 3)
    assert source_map.slice(span) == "日本"
    assert source_map.vscode_range(span) == TextRange(Position(0, 2), Position(0, 4))


@pytest.mark.parametrize(
    ("source", "row", "column", "offset"),
    [
        ("x = 1\n", 1, 0, 0),
        ("x = 1\n", 1, 5, 5),
        ("x = 1\n", 1, 6, 6),
        ("x = 1\r\n", 1, 6, 6),
        ("x = 1\r\n", 1, 7, 7),
        ("日本 = 1", 1, 2, 2),
    ],
)
def test_token_columns_include_physical_terminators(
    source: str,
    row: int,
    column: int,
    offset: int,
) -> None:
    """Catch token positions being constrained to VS Code line content."""
    assert SourceMap.from_text(source).offset_from_token(row, column) == offset


def test_rejects_crlf_and_surrogate_interiors() -> None:
    """Catch accepting UTF-16 or CRLF positions that clients cannot express."""
    source_map = SourceMap.from_text("😀\r\nx")
    with pytest.raises(
        PositionMappingError, match="^column is not a code-point boundary$"
    ):
        source_map.offset_from_vscode(0, 1)
    with pytest.raises(
        PositionMappingError, match="^offset is inside a line terminator$"
    ):
        source_map.vscode_from_offset(2)


def test_rejects_utf8_byte_interior() -> None:
    """Catch converting an AST byte column in the middle of a UTF-8 character."""
    source_map = SourceMap.from_text("日本 = 1")
    with pytest.raises(
        PositionMappingError, match="^column is not a code-point boundary$"
    ):
        source_map.offset_from_ast(1, 1)


def test_line_bases_and_final_empty_line_are_distinct() -> None:
    """Catch mixing AST/token one-based lines with VS Code zero-based lines."""
    source_map = SourceMap.from_text("日本\n")
    assert source_map.offset_from_ast(1, 6) == 2
    assert source_map.offset_from_token(1, 3) == 3
    assert source_map.offset_from_vscode(1, 0) == 3
    assert source_map.vscode_from_offset(3) == Position(1, 0)


@pytest.mark.parametrize(
    ("start", "end"),
    [
        (-1, 0),
        (1, 0),
    ],
)
def test_source_span_rejects_invalid_bounds(start: int, end: int) -> None:
    """Catch spans that can represent a negative or reversed source selection."""
    with pytest.raises(ValueError, match="^invalid source span$"):
        SourceSpan(start, end)


@pytest.mark.parametrize(
    ("call", "expected_message"),
    [
        (
            lambda source_map: source_map.offset_from_ast(0, 0),
            "line is outside the document",
        ),
        (
            lambda source_map: source_map.offset_from_token(2, 0),
            "line is outside the document",
        ),
        (
            lambda source_map: source_map.offset_from_token(1, -1),
            "token column is outside the physical line",
        ),
        (
            lambda source_map: source_map.offset_from_vscode(1, 0),
            "line is outside the document",
        ),
        (
            lambda source_map: source_map.vscode_from_offset(-1),
            "offset is outside the document",
        ),
        (
            lambda source_map: source_map.slice(SourceSpan(0, 99)),
            "span is outside the document",
        ),
    ],
)
def test_position_errors_are_source_free(
    call: Callable[[SourceMap], object],
    expected_message: str,
) -> None:
    """Catch diagnostics that leak the caller's document contents."""
    source = "private_😀"
    with pytest.raises(PositionMappingError) as caught:
        call(SourceMap.from_text(source))
    assert str(caught.value) == expected_message
    assert source not in str(caught.value)


def test_ast_positions_match_source_segments_with_non_bmp_fstring_content() -> None:
    """Catch byte-column offsets after astral literal content or a replacement field."""
    source = 'prefix = f"😀{value}𝄞"\n'
    tree = ast.parse(source)
    assignment = tree.body[0]
    assert isinstance(assignment, ast.Assign)
    value = assignment.value
    assert isinstance(value, ast.JoinedStr)
    assert value.end_lineno is not None
    assert value.end_col_offset is not None
    source_map = SourceMap.from_text(source)
    span = SourceSpan(
        source_map.offset_from_ast(value.lineno, value.col_offset),
        source_map.offset_from_ast(value.end_lineno, value.end_col_offset),
    )
    assert source_map.slice(span) == ast.get_source_segment(source, value)


@given(st.text(alphabet=st.characters(blacklist_categories=("Cs",))))
def test_vscode_round_trip(text: str) -> None:
    """Catch any mismatch between enumerated VS Code boundaries and conversions."""
    source_map = SourceMap.from_text(text)
    for offset in source_map.vscode_boundaries():
        position = source_map.vscode_from_offset(offset)
        assert (
            source_map.offset_from_vscode(position.line, position.character) == offset
        )


@given(st.text(alphabet=st.characters(blacklist_categories=("Cs",))))
def test_ast_utf8_positions_produce_ast_source_segments(value: str) -> None:
    """Catch AST byte-column mapping errors for parseable Unicode string assignments."""
    source = f"prefix = {value!r}; replacement = {value!r}\n"
    source_map = SourceMap.from_text(source)
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if not isinstance(node, ast.expr | ast.stmt):
            continue
        segment = ast.get_source_segment(source, node)
        if segment is None:
            continue
        assert node.end_lineno is not None
        assert node.end_col_offset is not None
        span = SourceSpan(
            source_map.offset_from_ast(node.lineno, node.col_offset),
            source_map.offset_from_ast(node.end_lineno, node.end_col_offset),
        )
        assert source_map.slice(span) == segment
