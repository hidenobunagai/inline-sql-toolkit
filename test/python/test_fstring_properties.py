import ast
import itertools
from collections.abc import Sequence
from typing import TypeVar

from hypothesis import assume, given
from hypothesis import strategies as st
from inline_sql_helper.candidate_formatter import (
    CandidateEdit,
    CandidateResult,
    CandidateUnchanged,
    format_candidate,
)
from inline_sql_helper.detection import detect_sql
from inline_sql_helper.literals import analyze_document
from inline_sql_helper.model import FormatOptions
from inline_sql_helper.positions import SourceMap, SourceSpan
from inline_sql_helper.sqlparse_adapter import format_sql

T = TypeVar("T")


def only(values: Sequence[T]) -> T:
    """Return the sole value, rejecting missing or ambiguous results."""
    assert len(values) == 1
    return values[0]


def direct_ast_field_spans(
    node: ast.JoinedStr,
    source_map: SourceMap,
) -> tuple[SourceSpan, ...]:
    """Derive top-level field envelopes directly from parser coordinates."""
    return tuple(
        SourceSpan(
            source_map.offset_from_ast(value.lineno, value.col_offset),
            source_map.offset_from_ast(value.end_lineno, value.end_col_offset),
        )
        for value in node.values
        if isinstance(value, ast.FormattedValue)
        and value.end_lineno is not None
        and value.end_col_offset is not None
    )


_VALID_FIELDS = (
    "{value}",
    "{value=}",
    "{value!s}",
    "{value!r}",
    "{value!a}",
    "{items[key]}",
    "{mapping[{'key': key}['key']]}",
    "{value:>{width}}",
    "{value:{width}.{precision}f}",
    "{(lambda item: item)(value)}",
    "{(\nvalue\n)}",
    "{value  # expression comment\n}",
    '{mapping["key"]}',
    '{f"{value}"}',
)


@st.composite
def valid_fstring_sources(draw: st.DrawFn) -> str:
    """Emit a finite grammar of valid PEP 701 f-string source forms."""
    fields = draw(
        st.lists(
            st.sampled_from(_VALID_FIELDS),
            min_size=1,
            max_size=3,
        )
    )
    left = draw(
        st.sampled_from(
            [
                "SELECT ",
                "SELECT {{literal}}, ",
                "{{{{adjacent}}}} SELECT ",
            ]
        )
    )
    separator = draw(st.sampled_from([", ", " }}{{ ", "\n"]))
    right = draw(st.sampled_from(["", " FROM table", " -- tail", " {{done}}"]))
    return f'query = f"""{left}{separator.join(fields)}{right}"""'


def assert_fields_match_formatted_values(
    source: str,
    spans: tuple[SourceSpan, ...],
) -> None:
    """Reparse independently and compare exact AST/source field envelopes."""
    source_map = SourceMap.from_text(source)
    tree = ast.parse(source)
    assignment = only(tuple(node for node in tree.body if isinstance(node, ast.Assign)))
    assert isinstance(assignment.value, ast.JoinedStr)
    joined = assignment.value
    expected = direct_ast_field_spans(joined, source_map)
    assert spans == expected
    assert all(left.end <= right.start for left, right in itertools.pairwise(spans))
    for span in spans:
        assert source_map.slice(span).startswith("{")
        assert source_map.slice(span).endswith("}")
        ast.parse(f'f"""{source_map.slice(span)}"""', mode="eval")


@given(valid_fstring_sources())
def test_scanned_fields_agree_with_ast(source: str) -> None:
    """Catch scanner drift for the finite PEP 701 field grammar."""
    analysis = analyze_document(source)
    literal = only(analysis.supported)
    assert_fields_match_formatted_values(source, literal.field_spans)


def _apply(source: str, result: CandidateResult) -> str:
    if isinstance(result, CandidateUnchanged):
        return source
    if isinstance(result, CandidateEdit):
        return (
            source[: result.source_span.start]
            + result.replacement_text
            + source[result.source_span.end :]
        )
    raise AssertionError("candidate was skipped")


@given(valid_fstring_sources())
def test_successful_format_preserves_fields_and_is_idempotent(source: str) -> None:
    """Formatting must retain every PEP 701 field spelling and converge."""
    analysis = analyze_document(source)
    literal = only(analysis.supported)
    result = format_candidate(
        source,
        analysis,
        literal,
        detect_sql(literal, analysis.source_map),
        FormatOptions("upper", 2, 88, True),
        nonce="33" * 16,
        sql_formatter=format_sql,
    )
    assume(isinstance(result, (CandidateEdit, CandidateUnchanged)))
    updated = _apply(source, result)
    ast.parse(updated)
    updated_analysis = analyze_document(updated)
    updated_literal = only(updated_analysis.supported)
    assert tuple(
        updated_analysis.source_map.slice(span) for span in updated_literal.field_spans
    ) == tuple(analysis.source_map.slice(span) for span in literal.field_spans)
    second_analysis = analyze_document(updated)
    second_literal = only(second_analysis.supported)
    second = format_candidate(
        updated,
        second_analysis,
        second_literal,
        detect_sql(second_literal, second_analysis.source_map),
        FormatOptions("upper", 2, 88, True),
        nonce="33" * 16,
        sql_formatter=format_sql,
    )
    assert isinstance(second, CandidateUnchanged)
