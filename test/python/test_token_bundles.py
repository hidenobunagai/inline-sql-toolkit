import sys
import token
import tokenize

import pytest
from inline_sql_helper.positions import SourceMap, SourceSpan
from inline_sql_helper.token_bundles import (
    SourceToken,
    StringTokenBundle,
    UnsafeFieldScan,
    UnsupportedStringSyntax,
    scan_fstring_field_spans,
    scan_string_bundles,
    tokenize_source,
)


def _tokens(source: str) -> tuple[SourceToken, ...]:
    source_map = SourceMap.from_text(source)
    return tokenize_source(source, source_map)


def _fstring_bundle(source: str) -> tuple[StringTokenBundle, SourceMap]:
    source_map = SourceMap.from_text(source)
    bundles = scan_string_bundles(tokenize_source(source, source_map))
    assert len(bundles) == 1
    return bundles[0], source_map


def test_empty_document_has_no_positioned_tokens() -> None:
    """Catch attempting to position the virtual end marker."""
    assert _tokens("") == ()


@pytest.mark.parametrize(
    ("source", "expected_text"),
    [
        ('query = "SELECT 1"', ("query", "=", '"SELECT 1"')),
        (
            'if ready:\n    query = "SELECT 1"',
            ("if", "ready", ":", "\n", "    ", "query", "=", '"SELECT 1"'),
        ),
    ],
)
def test_virtual_eof_tokens_are_omitted_before_position_conversion(
    source: str,
    expected_text: tuple[str, ...],
) -> None:
    """Catch mapping zero-text NEWLINE or DEDENT tokens beyond the document."""
    tokens = _tokens(source)
    assert tuple(item.text for item in tokens) == expected_text
    assert all(
        item.text
        or item.token_type
        not in {tokenize.NEWLINE, tokenize.NL, tokenize.INDENT, tokenize.DEDENT}
        for item in tokens
    )


def test_fstring_at_eof_retains_every_nonempty_token() -> None:
    """Catch dropping field tokens while filtering virtual EOF markers."""
    tokens = _tokens('query = f"SELECT {value}"')
    assert tuple(item.text for item in tokens) == (
        "query",
        "=",
        'f"',
        "SELECT ",
        "{",
        "value",
        "}",
        '"',
    )
    assert all(item.text for item in tokens)


def test_token_spans_use_code_points_after_non_bmp_text() -> None:
    """Catch treating tokenizer columns as UTF-8 or UTF-16 columns."""
    source = '😀_comment = 1; query = "SELECT 𝄞"\n'
    string_token = next(
        item for item in _tokens(source) if item.token_type == tokenize.STRING
    )
    assert string_token.span == SourceSpan(23, 33)
    assert source[string_token.span.start : string_token.span.end] == '"SELECT 𝄞"'


def test_plain_tokens_become_source_ordered_single_token_bundles() -> None:
    """Catch dropping or reordering independent STRING tokens."""
    source = '# before\nfirst = "A"; second = r"B"\n'
    bundles = scan_string_bundles(_tokens(source))
    assert tuple(bundle.kind for bundle in bundles) == ("string", "string")
    assert tuple(bundle.span for bundle in bundles) == (
        SourceSpan(17, 20),
        SourceSpan(31, 35),
    )
    assert tuple(len(bundle.tokens) for bundle in bundles) == (1, 1)


@pytest.mark.parametrize(
    "prefix",
    ["f", "F", "rf", "rF", "Rf", "RF", "fr", "fR", "Fr", "FR"],
)
def test_fstring_prefixes_are_retained_as_one_deferred_bundle(prefix: str) -> None:
    """Catch prefix guessing that loses raw/f-string token ownership."""
    source = f'query = {prefix}"SELECT {{value}}"'
    bundles = scan_string_bundles(_tokens(source))
    assert len(bundles) == 1
    bundle = bundles[0]
    assert bundle.kind == "fstring"
    assert bundle.span == SourceSpan(8, len(source))
    assert source[bundle.span.start : bundle.span.end] == source[8:]
    assert bundle.tokens[0].text == f'{prefix}"'
    assert bundle.tokens[-1].text == '"'


def test_nested_fstring_tokens_stay_inside_the_outer_bundle() -> None:
    """Catch emitting nested replacement-expression strings as extra bundles."""
    source = "query = f\"SELECT {f'{value}'}\""
    bundles = scan_string_bundles(_tokens(source))
    assert len(bundles) == 1
    bundle = bundles[0]
    assert bundle.kind == "fstring"
    assert bundle.span == SourceSpan(8, len(source))
    assert (
        sum(
            item.token_type == getattr(token, "FSTRING_START") for item in bundle.tokens
        )
        == 2
    )
    assert (
        sum(item.token_type == getattr(token, "FSTRING_END") for item in bundle.tokens)
        == 2
    )


def test_plain_string_inside_fstring_field_is_owned_by_outer_bundle() -> None:
    """Catch one AST f-string surface becoming multiple top-level bundles."""
    source = "query = f\"SELECT {lookup['column']}\""
    bundles = scan_string_bundles(_tokens(source))
    assert len(bundles) == 1
    assert bundles[0].kind == "fstring"
    assert any(item.token_type == tokenize.STRING for item in bundles[0].tokens)


@pytest.mark.parametrize(
    ("literal_source", "fields"),
    [
        ('f"SELECT {value}"', ("{value}",)),
        ('f"SELECT {{literal}}, {items[{key}]}"', ("{items[{key}]}",)),
        ('f"SELECT {value!r:>{width}}"', ("{value!r:>{width}}",)),
        ('f"SELECT {f"{value}"}"', ('{f"{value}"}',)),
        ('f"SELECT {left}, {right}"', ("{left}", "{right}")),
    ],
)
def test_scanner_returns_complete_top_level_fields(
    literal_source: str,
    fields: tuple[str, ...],
) -> None:
    """Catch losing field state across braces, format specs, or nested f-strings."""
    source = f"query = {literal_source}"
    bundle, source_map = _fstring_bundle(source)
    spans = scan_fstring_field_spans(bundle, source_map)
    assert tuple(source_map.slice(span) for span in spans) == fields


def test_scanner_rejects_an_unbalanced_replacement_field_source_free() -> None:
    """Catch accepting a mismatched closer or leaking its expression in an error."""
    private_name = "private_customer"
    fstring_start = getattr(token, "FSTRING_START")
    fstring_end = getattr(token, "FSTRING_END")
    tokens = (
        SourceToken(fstring_start, fstring_start, 'f"', SourceSpan(0, 2)),
        SourceToken(token.LBRACE, token.LBRACE, "{", SourceSpan(2, 3)),
        SourceToken(token.NAME, token.NAME, private_name, SourceSpan(3, 19)),
        SourceToken(token.RSQB, token.RSQB, "]", SourceSpan(19, 20)),
        SourceToken(fstring_end, fstring_end, '"', SourceSpan(20, 21)),
    )
    bundle = StringTokenBundle("fstring", SourceSpan(0, 21), tokens)
    with pytest.raises(
        UnsafeFieldScan, match="^unbalanced replacement field$"
    ) as caught:
        scan_fstring_field_spans(bundle, SourceMap.from_text('f"{private_customer]"'))
    assert private_name not in str(caught.value)


def test_scanner_rejects_an_unterminated_nested_fstring_source_free() -> None:
    """Catch reporting a partial outer field when nested f-string state is open."""
    private_name = "private_customer"
    fstring_start = getattr(token, "FSTRING_START")
    tokens = (
        SourceToken(fstring_start, fstring_start, 'f"', SourceSpan(0, 2)),
        SourceToken(token.LBRACE, token.LBRACE, "{", SourceSpan(2, 3)),
        SourceToken(fstring_start, fstring_start, 'f"', SourceSpan(3, 5)),
        SourceToken(token.NAME, token.NAME, private_name, SourceSpan(5, 21)),
    )
    bundle = StringTokenBundle("fstring", SourceSpan(0, 21), tokens)
    with pytest.raises(
        UnsafeFieldScan, match="^unterminated f-string field$"
    ) as caught:
        scan_fstring_field_spans(bundle, SourceMap.from_text('f"{f"private_customer'))
    assert private_name not in str(caught.value)


def test_nested_fstring_cannot_close_its_outer_replacement_field() -> None:
    """Catch popping an outer brace at the wrong f-string nesting depth."""
    fstring_start = getattr(token, "FSTRING_START")
    fstring_end = getattr(token, "FSTRING_END")
    tokens = (
        SourceToken(fstring_start, fstring_start, 'f"', SourceSpan(0, 2)),
        SourceToken(token.LBRACE, token.LBRACE, "{", SourceSpan(2, 3)),
        SourceToken(fstring_start, fstring_start, 'f"', SourceSpan(3, 5)),
        SourceToken(token.RBRACE, token.RBRACE, "}", SourceSpan(5, 6)),
        SourceToken(fstring_end, fstring_end, '"', SourceSpan(6, 7)),
        SourceToken(fstring_end, fstring_end, '"', SourceSpan(7, 8)),
    )
    bundle = StringTokenBundle("fstring", SourceSpan(0, 8), tokens)
    with pytest.raises(UnsafeFieldScan, match="^unbalanced replacement field$"):
        scan_fstring_field_spans(bundle, SourceMap.from_text('f"{f"}""'))


def test_scanner_rejects_fstring_end_before_start() -> None:
    """Catch accepting an invalid f-string nesting sequence with net-zero depth."""
    fstring_start = getattr(token, "FSTRING_START")
    fstring_end = getattr(token, "FSTRING_END")
    tokens = (
        SourceToken(fstring_end, fstring_end, '"', SourceSpan(0, 1)),
        SourceToken(fstring_start, fstring_start, 'f"', SourceSpan(1, 3)),
    )
    bundle = StringTokenBundle("fstring", SourceSpan(0, 3), tokens)
    with pytest.raises(UnsafeFieldScan, match="^invalid f-string token state$"):
        scan_fstring_field_spans(bundle, SourceMap.from_text('"f"'))


def test_scanner_rejects_nested_fstring_outside_a_replacement_field() -> None:
    """Catch accepting a nested f-string token sequence in literal content."""
    fstring_start = getattr(token, "FSTRING_START")
    fstring_end = getattr(token, "FSTRING_END")
    tokens = (
        SourceToken(fstring_start, fstring_start, 'f"', SourceSpan(0, 2)),
        SourceToken(fstring_start, fstring_start, 'f"', SourceSpan(2, 4)),
        SourceToken(fstring_end, fstring_end, '"', SourceSpan(4, 5)),
        SourceToken(fstring_end, fstring_end, '"', SourceSpan(5, 6)),
    )
    bundle = StringTokenBundle("fstring", SourceSpan(0, 6), tokens)
    with pytest.raises(UnsafeFieldScan, match="^invalid f-string token state$"):
        scan_fstring_field_spans(bundle, SourceMap.from_text('f"f"""'))


def test_unterminated_synthetic_fstring_bundle_is_rejected_source_free() -> None:
    """Catch silently accepting a start token without its matching end."""
    fstring_start = getattr(token, "FSTRING_START")
    tokens = (
        SourceToken(fstring_start, fstring_start, 'f"', SourceSpan(0, 2)),
        SourceToken(token.NAME, token.NAME, "private_name", SourceSpan(3, 15)),
    )
    with pytest.raises(
        UnsupportedStringSyntax, match="^unterminated string token bundle$"
    ) as caught:
        scan_string_bundles(tokens)
    assert "private_name" not in str(caught.value)


@pytest.mark.skipif(
    sys.version_info < (3, 14),
    reason="t-string token constants are available on Python 3.14+",
)
def test_tstring_tokens_form_one_nested_bundle() -> None:
    """Catch t-string tokens leaking as plain or nested top-level bundles."""
    source = "query = t\"SELECT {t'{value}'}\""
    bundles = scan_string_bundles(_tokens(source))
    assert len(bundles) == 1
    bundle = bundles[0]
    assert bundle.kind == "tstring"
    assert bundle.span == SourceSpan(8, len(source))
    tstring_start = getattr(token, "TSTRING_START")
    assert sum(item.token_type == tstring_start for item in bundle.tokens) == 2
