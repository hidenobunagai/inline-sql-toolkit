import ast
import sys
import token
from collections.abc import Sequence
from dataclasses import replace
from typing import TypeVar

import pytest
from inline_sql_helper.literals import (
    LiteralKind,
    SupportedLiteral,
    UnsupportedLiteral,
    UnsupportedStringSyntax,
    analyze_document,
    classify_fstring,
    split_plain_string,
)
from inline_sql_helper.model import ReasonCode
from inline_sql_helper.positions import SourceMap, SourceSpan
from inline_sql_helper.token_bundles import (
    SourceToken,
    StringTokenBundle,
    scan_string_bundles,
    tokenize_source,
)

T = TypeVar("T")


def only(values: Sequence[T]) -> T:
    """Return the sole value, rejecting missing or ambiguous results."""
    assert len(values) == 1
    return values[0]


def _fstring_parts(
    source: str,
) -> tuple[ast.expr, StringTokenBundle, SourceMap]:
    source_map = SourceMap.from_text(source)
    tree = ast.parse(source)
    assignment = only(tuple(node for node in tree.body if isinstance(node, ast.Assign)))
    bundles = scan_string_bundles(tokenize_source(source, source_map))
    return assignment.value, only(bundles), source_map


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


@pytest.mark.parametrize(
    "prefix",
    ["f", "F", "rf", "rF", "Rf", "RF", "fr", "fR", "Fr", "FR"],
)
@pytest.mark.parametrize("delimiter", ["'", '"', "'''", '"""'])
def test_supported_fstring_prefix_and_delimiter(
    prefix: str,
    delimiter: str,
) -> None:
    """Catch rejecting an approved f-string spelling or delimiter."""
    analysis = analyze_document(
        f"query = {prefix}{delimiter}SELECT {{value}}{delimiter}"
    )
    literal = only(analysis.supported)
    assert analysis.source_map.slice(literal.span) == (
        f"{prefix}{delimiter}SELECT {{value}}{delimiter}"
    )
    assert analysis.source_map.slice(literal.content_span) == "SELECT {value}"
    assert tuple(analysis.source_map.slice(span) for span in literal.field_spans) == (
        "{value}",
    )
    assert literal.prefix == prefix
    assert literal.delimiter == delimiter
    assert literal.kind is (
        LiteralKind.FSTRING if prefix.casefold() == "f" else LiteralKind.RAW_FSTRING
    )
    assert analysis.unsupported == ()


@pytest.mark.parametrize(
    ("literal_source", "fields"),
    [
        ('f"SELECT {value}"', ("{value}",)),
        ('f"SELECT {value=}"', ("{value=}",)),
        ('f"SELECT {value!s}"', ("{value!s}",)),
        ('f"SELECT {value!r:>{width}}"', ("{value!r:>{width}}",)),
        ('f"SELECT {value!a}"', ("{value!a}",)),
        ('f"SELECT {{x}}, {items[{key}]}"', ("{items[{key}]}",)),
        ('f"""SELECT {(\nvalue\n)}"""', ("{(\nvalue\n)}",)),
        (
            'f"""SELECT {value  # expression comment\n}"""',
            ("{value  # expression comment\n}",),
        ),
        ('f"SELECT {mapping["key"]}"', ('{mapping["key"]}',)),
        ('f"SELECT {f"{value}"}"', ('{f"{value}"}',)),
        ('f"SELECT {left}, {right}"', ("{left}", "{right}")),
        ('f"SELECT {{{value}}}"', ("{value}",)),
    ],
)
def test_exact_top_level_field_spans(
    literal_source: str,
    fields: tuple[str, ...],
) -> None:
    """Catch reconstructing or truncating any PEP 701 replacement field."""
    source = f"query = {literal_source}"
    analysis = analyze_document(source)
    literal = only(analysis.supported)
    assert (
        tuple(analysis.source_map.slice(span) for span in literal.field_spans) == fields
    )
    assert analysis.unsupported == ()


def test_nested_plain_string_inside_fstring_stays_in_the_outer_field() -> None:
    """Catch publishing a field's plain string as a separate literal."""
    source = "query = f\"SELECT {lookup['column']}\""
    analysis = analyze_document(source)
    literal = only(analysis.supported)
    assert tuple(analysis.source_map.slice(span) for span in literal.field_spans) == (
        "{lookup['column']}",
    )
    assert analysis.unsupported == ()


def test_fieldless_fstring_is_supported_with_no_replacement_spans() -> None:
    """Catch requiring at least one replacement field for safe promotion."""
    analysis = analyze_document('query = f"SELECT 1"')
    literal = only(analysis.supported)
    assert literal.kind is LiteralKind.FSTRING
    assert literal.field_spans == ()
    assert analysis.unsupported == ()


def test_classification_rejects_a_non_joined_ast_node_as_one_skip() -> None:
    """Catch promoting a token bundle without one matching JoinedStr owner."""
    source = 'query = f"SELECT {value}"'
    _node, bundle, source_map = _fstring_parts(source)
    result = classify_fstring(ast.Constant(value="not joined"), bundle, source_map)
    assert result == UnsupportedLiteral(
        span=bundle.span,
        detection_content_span=None,
        reason=ReasonCode.UNSUPPORTED_LITERAL,
    )


def test_classification_rejects_a_non_fstring_bundle_as_one_skip() -> None:
    """Catch promoting a token unit that is not classified as an f-string."""
    source = 'query = f"SELECT {value}"'
    node, bundle, source_map = _fstring_parts(source)
    plain_bundle = StringTokenBundle("string", bundle.span, bundle.tokens)
    result = classify_fstring(node, plain_bundle, source_map)
    assert result == UnsupportedLiteral(
        span=bundle.span,
        detection_content_span=None,
        reason=ReasonCode.UNSUPPORTED_LITERAL,
    )


def test_classification_rejects_a_surface_mismatch_as_one_skip() -> None:
    """Catch guessing content boundaries from an incomplete token envelope."""
    source = 'query = f"SELECT {value}"'
    node, bundle, source_map = _fstring_parts(source)
    incomplete = replace(
        bundle,
        span=SourceSpan(bundle.span.start, bundle.span.end - 1),
    )
    result = classify_fstring(node, incomplete, source_map)
    assert result == UnsupportedLiteral(
        span=incomplete.span,
        detection_content_span=None,
        reason=ReasonCode.UNSUPPORTED_LITERAL,
    )


def test_classification_rejects_an_unsupported_prefix_without_detection() -> None:
    """Catch widening f-string prefixes or exposing guessed content."""
    valid_source = 'query = f"SELECT {value}"'
    node, bundle, _source_map = _fstring_parts(valid_source)
    unsupported_source = 'query = xf"SELECT {value}"'
    unsupported_map = SourceMap.from_text(unsupported_source)
    unsupported_bundle = replace(
        bundle,
        span=SourceSpan(bundle.span.start, len(unsupported_source)),
    )
    result = classify_fstring(node, unsupported_bundle, unsupported_map)
    assert result == UnsupportedLiteral(
        span=unsupported_bundle.span,
        detection_content_span=None,
        reason=ReasonCode.UNSUPPORTED_LITERAL,
    )


def test_classification_turns_scanner_failure_into_one_safe_skip() -> None:
    """Catch partially promoting fields after token state becomes unsafe."""
    source = 'query = f"SELECT {private_customer}"'
    node, bundle, source_map = _fstring_parts(source)
    broken_tokens = tuple(
        item for item in bundle.tokens if item.exact_type != token.RBRACE
    )
    broken_bundle = replace(bundle, tokens=broken_tokens)
    result = classify_fstring(node, broken_bundle, source_map)
    assert result == UnsupportedLiteral(
        span=bundle.span,
        detection_content_span=SourceSpan(10, len(source) - 1),
        reason=ReasonCode.UNSAFE_FSTRING_RESTORE,
    )


def test_classification_turns_ast_envelope_mismatch_into_one_safe_skip() -> None:
    """Catch accepting token spans that differ from the parser's exact envelope."""
    source = 'query = f"SELECT {private_customer}"'
    node, bundle, source_map = _fstring_parts(source)
    changed_tokens: list[SourceToken] = []
    for item in bundle.tokens:
        if item.exact_type == token.RBRACE:
            changed_tokens.append(
                replace(item, span=SourceSpan(item.span.start, item.span.end - 1))
            )
        else:
            changed_tokens.append(item)
    changed_bundle = replace(bundle, tokens=tuple(changed_tokens))
    result = classify_fstring(node, changed_bundle, source_map)
    assert result == UnsupportedLiteral(
        span=bundle.span,
        detection_content_span=SourceSpan(10, len(source) - 1),
        reason=ReasonCode.UNSAFE_FSTRING_RESTORE,
    )


def test_classification_promotes_multiple_fields_without_reordering() -> None:
    """Catch returning only one field or changing source order."""
    source = 'query = f"SELECT {left}, {right}"'
    node, bundle, source_map = _fstring_parts(source)
    result = classify_fstring(node, bundle, source_map)
    assert isinstance(result, SupportedLiteral)
    assert tuple(source_map.slice(span) for span in result.field_spans) == (
        "{left}",
        "{right}",
    )


def test_implicitly_concatenated_fstrings_are_one_unsupported_unit() -> None:
    """Catch promoting one bundle from a JoinedStr that owns two surfaces."""
    source = 'query = f"SELECT {left}" f", {right}"'
    analysis = analyze_document(source)
    assert analysis.supported == ()
    assert analysis.unsupported == (
        UnsupportedLiteral(
            span=SourceSpan(8, len(source)),
            detection_content_span=SourceSpan(10, 23),
            reason=ReasonCode.UNSUPPORTED_LITERAL,
        ),
    )


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


@pytest.mark.parametrize("prefix", ["u", "U"])
def test_u_string_below_addition_has_no_detection_span(prefix: str) -> None:
    """Catch shape classification exposing a prohibited u-string content span."""
    source = f'query = {prefix}"SELECT 1" + "x"'
    analysis = analyze_document(source)
    assert analysis.supported == ()
    assert tuple(item.span for item in analysis.unsupported) == (
        SourceSpan(8, 19),
        SourceSpan(22, 25),
    )
    assert tuple(item.detection_content_span for item in analysis.unsupported) == (
        None,
        SourceSpan(23, 24),
    )


@pytest.mark.parametrize(
    ("surface", "detection_span"),
    [
        ('u"SELECT 1" "x"', None),
        ('U"SELECT 1" "x"', None),
        ('"SELECT 1" u"x"', SourceSpan(9, 17)),
        ('"SELECT 1" U"x"', SourceSpan(9, 17)),
    ],
)
def test_u_string_in_implicit_concatenation_is_never_the_detection_surface(
    surface: str,
    detection_span: SourceSpan | None,
) -> None:
    """Catch selecting a u-prefixed body from a multi-token AST envelope."""
    analysis = analyze_document(f"query = {surface}")
    assert analysis.supported == ()
    assert len(analysis.unsupported) == 1
    unsupported = analysis.unsupported[0]
    assert unsupported.span == SourceSpan(8, 23)
    assert unsupported.detection_content_span == detection_span
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
