import sys
import token
import tokenize

import pytest
from inline_sql_helper.positions import SourceMap, SourceSpan
from inline_sql_helper.token_bundles import (
    SourceToken,
    UnsupportedStringSyntax,
    scan_string_bundles,
    tokenize_source,
)


def _tokens(source: str) -> tuple[SourceToken, ...]:
    source_map = SourceMap.from_text(source)
    return tokenize_source(source, source_map)


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
