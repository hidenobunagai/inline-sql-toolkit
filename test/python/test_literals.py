import sys

import pytest
from inline_sql_helper.literals import (
    LiteralKind,
    UnsupportedStringSyntax,
    analyze_document,
    split_plain_string,
)
from inline_sql_helper.model import ReasonCode
from inline_sql_helper.positions import SourceSpan


@pytest.mark.parametrize("prefix", ["", "r", "R"])
@pytest.mark.parametrize("delimiter", ["'", '"', "'''", '"""'])
def test_supported_prefix_and_delimiter(prefix: str, delimiter: str) -> None:
    """Catch rejecting an approved spelling or misplacing its content boundary."""
    surface = f"{prefix}{delimiter}SELECT 1{delimiter}"
    source = f"query = {surface}"
    analysis = analyze_document(source)
    assert len(analysis.supported) == 1
    literal = analysis.supported[0]
    assert literal.span == SourceSpan(8, len(source))
    assert analysis.source_map.slice(literal.span) == surface
    assert literal.content_span == SourceSpan(
        8 + len(prefix) + len(delimiter),
        len(source) - len(delimiter),
    )
    assert analysis.source_map.slice(literal.content_span) == "SELECT 1"
    assert literal.prefix == prefix
    assert literal.delimiter == delimiter
    assert literal.kind == (
        LiteralKind.RAW if prefix.casefold() == "r" else LiteralKind.PLAIN
    )
    assert literal.field_spans == ()
    assert analysis.unsupported == ()


@pytest.mark.parametrize("delimiter", ["'''", '"""'])
def test_triple_string_keeps_blank_boundary_lines(delimiter: str) -> None:
    """Catch trimming blank lines while deriving a triple-string content span."""
    source = f"query = {delimiter}\n\nSELECT 1\n\n{delimiter}\n"
    analysis = analyze_document(source)
    assert len(analysis.supported) == 1
    literal = analysis.supported[0]
    assert literal.span == SourceSpan(8, 26)
    assert literal.content_span == SourceSpan(11, 23)
    assert analysis.source_map.slice(literal.content_span) == "\n\nSELECT 1\n\n"


def test_split_plain_string_rejects_unapproved_surface_without_source_leak() -> None:
    """Catch prefix widening or source-bearing validation diagnostics."""
    private_surface = 'u"SELECT private_email"'
    with pytest.raises(UnsupportedStringSyntax) as caught:
        split_plain_string(private_surface, SourceSpan(0, len(private_surface)))
    assert private_surface not in str(caught.value)


def test_zero_strings_produces_empty_literal_collections() -> None:
    """Catch manufacturing candidates from names, comments, or numbers."""
    analysis = analyze_document("# SELECT private\nanswer = 42\n")
    assert analysis.supported == ()
    assert analysis.unsupported == ()


def test_independent_literals_in_nested_containers_remain_source_ordered() -> None:
    """Catch traversal order replacing source order across nested AST containers."""
    source = 'first = {"query": ["SELECT 1"]}\nif ready:\n    second = ("SELECT 2",)\n'
    analysis = analyze_document(source)
    assert tuple(literal.span for literal in analysis.supported) == (
        SourceSpan(9, 16),
        SourceSpan(19, 29),
        SourceSpan(56, 66),
    )
    assert tuple(
        analysis.source_map.slice(literal.content_span)
        for literal in analysis.supported
    ) == ("query", "SELECT 1", "SELECT 2")
    assert analysis.unsupported == ()


def test_comments_semicolons_non_bmp_and_statements_map_exact_ast_envelopes() -> None:
    """Catch evaluated-value matching or byte-column drift between AST and tokens."""
    source = '# 😀\nfirst = "SELECT 𝄞"; second = r"SELECT 2"\nthird = "SELECT 3"\n'
    analysis = analyze_document(source)
    assert tuple(literal.span for literal in analysis.supported) == (
        SourceSpan(12, 22),
        SourceSpan(33, 44),
        SourceSpan(53, 63),
    )
    assert tuple(
        analysis.source_map.slice(literal.content_span)
        for literal in analysis.supported
    ) == ("SELECT 𝄞", "SELECT 2", "SELECT 3")


@pytest.mark.parametrize(
    "surface",
    [
        'b"SELECT 1"',
        'B"SELECT 1"',
        'br"SELECT 1"',
        'Rb"SELECT 1"',
        'u"SELECT 1"',
        'U"SELECT 1"',
    ],
)
def test_bytes_and_u_strings_are_unsupported_without_detection_span(
    surface: str,
) -> None:
    """Catch exposing non-candidate content as a SQL detection range."""
    source = f"query = {surface}"
    analysis = analyze_document(source)
    assert analysis.supported == ()
    assert len(analysis.unsupported) == 1
    unsupported = analysis.unsupported[0]
    assert unsupported.span == SourceSpan(8, len(source))
    assert unsupported.detection_content_span is None
    assert unsupported.reason == ReasonCode.UNSUPPORTED_LITERAL


def test_bytes_only_document_is_consumed_once() -> None:
    """Catch leaving a bytes bundle unmatched or reporting it more than once."""
    analysis = analyze_document('b"private sql"')
    assert analysis.supported == ()
    assert len(analysis.unsupported) == 1
    assert analysis.unsupported[0].span == SourceSpan(0, 14)


def test_fstring_is_deferred_as_one_consumed_bundle() -> None:
    """Catch premature Task 6 publication or duplicate unsupported reporting."""
    analysis = analyze_document('query = f"SELECT {value}"')
    assert analysis.supported == ()
    assert analysis.unsupported == ()


def test_nested_plain_string_inside_fstring_is_not_published_separately() -> None:
    """Catch generic-visiting JoinedStr internals or double-consuming its bundle."""
    analysis = analyze_document("query = f\"SELECT {lookup['column']}\"")
    assert analysis.supported == ()
    assert analysis.unsupported == ()


def test_implicit_concatenation_is_one_unsupported_literal_unit() -> None:
    """Catch treating two tokens owned by one AST node as two literals."""
    source = 'query = "SELECT " "1"\n'
    analysis = analyze_document(source)
    assert analysis.supported == ()
    assert len(analysis.unsupported) == 1
    unsupported = analysis.unsupported[0]
    assert unsupported.span == SourceSpan(8, 21)
    detection_span = unsupported.detection_content_span
    assert detection_span is not None
    assert detection_span == SourceSpan(9, 16)
    assert analysis.source_map.slice(detection_span) == "SELECT "
    assert unsupported.reason == ReasonCode.UNSUPPORTED_LITERAL


def test_nested_additions_mark_every_literal_unsupported_in_source_order() -> None:
    """Catch resetting addition state before visiting a nested Add expression."""
    source = 'query = "SELECT 1" + ("SELECT 2" + "SELECT 3")'
    analysis = analyze_document(source)
    assert analysis.supported == ()
    assert tuple(item.span for item in analysis.unsupported) == (
        SourceSpan(8, 18),
        SourceSpan(22, 32),
        SourceSpan(35, 45),
    )
    assert tuple(item.detection_content_span for item in analysis.unsupported) == (
        SourceSpan(9, 17),
        SourceSpan(23, 31),
        SourceSpan(36, 44),
    )
    assert all(
        item.reason == ReasonCode.UNSUPPORTED_LITERAL for item in analysis.unsupported
    )


def test_fstring_below_addition_is_unsupported_not_deferred() -> None:
    """Catch deferral taking precedence over the unsupported Add shape."""
    source = 'query = f"SELECT {value}" + " LIMIT 1"'
    analysis = analyze_document(source)
    assert analysis.supported == ()
    assert tuple(item.span for item in analysis.unsupported) == (
        SourceSpan(8, 25),
        SourceSpan(28, 38),
    )
    assert analysis.unsupported[0].detection_content_span == SourceSpan(10, 24)
    assert analysis.unsupported[1].detection_content_span == SourceSpan(29, 37)


@pytest.mark.parametrize(
    "source",
    [
        'query = z"SELECT 1"',
        'query = "SELECT 1',
        'query = t"SELECT {value}"',
    ],
)
@pytest.mark.skipif(
    sys.version_info >= (3, 14),
    reason="t-strings become valid syntax on Python 3.14",
)
def test_invalid_python_is_a_whole_document_parse_failure(source: str) -> None:
    """Catch converting parser failures into literal skips."""
    with pytest.raises(SyntaxError):
        analyze_document(source)


@pytest.mark.parametrize(
    "source",
    [
        'query = z"SELECT 1"',
        'query = "SELECT 1',
    ],
)
@pytest.mark.skipif(
    sys.version_info < (3, 14),
    reason="the lower-version table also carries the invalid t-string case",
)
def test_invalid_python_on_314_is_a_whole_document_parse_failure(source: str) -> None:
    """Catch converting parser failures into literal skips."""
    with pytest.raises(SyntaxError):
        analyze_document(source)


@pytest.mark.skipif(
    sys.version_info < (3, 14),
    reason="TemplateStr is available on Python 3.14+",
)
def test_tstring_is_consumed_once_without_visiting_internal_constants() -> None:
    """Catch exposing t-string content or generic-visiting internal Constant nodes."""
    source = 'query = t"SELECT {value} FROM private"'
    analysis = analyze_document(source)
    assert analysis.supported == ()
    assert len(analysis.unsupported) == 1
    unsupported = analysis.unsupported[0]
    assert unsupported.span == SourceSpan(8, len(source))
    assert unsupported.detection_content_span is None
    assert unsupported.reason == ReasonCode.UNSUPPORTED_LITERAL


def test_outputs_are_strictly_source_ordered_across_supported_and_unsupported() -> None:
    """Catch preserving AST/container order instead of sorting each output stream."""
    source = (
        'unsupported_first = u"SELECT 1"\n'
        'supported_first = "SELECT 2"\n'
        'unsupported_second = "SELECT 3" + "SELECT 4"\n'
        'supported_second = r"SELECT 5"\n'
    )
    analysis = analyze_document(source)
    assert tuple(item.span for item in analysis.supported) == (
        SourceSpan(50, 60),
        SourceSpan(125, 136),
    )
    assert tuple(item.span for item in analysis.unsupported) == (
        SourceSpan(20, 31),
        SourceSpan(82, 92),
        SourceSpan(95, 105),
    )
    assert all(
        left.span.end <= right.span.start
        for items in (analysis.supported, analysis.unsupported)
        for left, right in zip(items, items[1:], strict=False)
    )
