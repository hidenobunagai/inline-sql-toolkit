"""Safety tests for formatting one SQL-bearing Python literal."""

from __future__ import annotations

import ast
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Never, cast

import pytest
from inline_sql_helper import candidate_formatter
from inline_sql_helper.candidate_formatter import (
    CandidateEdit,
    CandidateSkip,
    CandidateUnchanged,
    SqlFormatter,
    format_candidate,
)
from inline_sql_helper.detection import detect_sql
from inline_sql_helper.literals import analyze_document
from inline_sql_helper.model import FormatOptions, ReasonCode
from inline_sql_helper.sqlparse_adapter import format_sql

OPTIONS = FormatOptions("upper", 2, 88, True)
NONCE = "22" * 16


def format_only_candidate(
    source: str,
    *,
    sql_formatter: SqlFormatter = format_sql,
) -> CandidateEdit | CandidateUnchanged | CandidateSkip:
    analysis = analyze_document(source)
    literal = analysis.supported[0]
    return format_candidate(
        source,
        analysis,
        literal,
        detect_sql(literal, analysis.source_map),
        OPTIONS,
        nonce=NONCE,
        sql_formatter=sql_formatter,
    )


def apply_candidate_result(
    source: str,
    result: CandidateEdit | CandidateUnchanged | CandidateSkip,
) -> str:
    if isinstance(result, CandidateEdit):
        return (
            source[: result.source_span.start]
            + result.replacement_text
            + source[result.source_span.end :]
        )
    if isinstance(result, CandidateUnchanged):
        return source
    raise AssertionError("candidate was skipped")


def test_already_formatted_is_unchanged() -> None:
    result = format_only_candidate('query = "SELECT 1"')
    assert isinstance(result, CandidateUnchanged)


def test_stale_analysis_is_safely_skipped() -> None:
    analysis = analyze_document('query = "SELECT 1"')
    literal = analysis.supported[0]
    result = format_candidate(
        'query = "select 1"',
        analysis,
        literal,
        detect_sql(literal, analysis.source_map),
        OPTIONS,
        nonce=NONCE,
        sql_formatter=format_sql,
    )
    assert isinstance(result, CandidateSkip)
    assert result.reason is ReasonCode.FORMATTER_FAILED


def test_format_returns_guarded_edit() -> None:
    source = 'query = "select a from table where x=1"'
    result = format_only_candidate(source)
    assert isinstance(result, CandidateEdit)
    assert result.expected_text == '"select a from table where x=1"'
    assert result.replacement_text == '"SELECT a FROM TABLE WHERE x = 1"'
    assert apply_candidate_result(source, result) == (
        'query = "SELECT a FROM TABLE WHERE x = 1"'
    )
    ast.parse(apply_candidate_result(source, result))


@pytest.mark.parametrize("formatted", ["SELECT\n1", 'SELECT "', "SELECT \\"])
def test_adversarial_output_is_skipped(formatted: str) -> None:
    @dataclass(slots=True)
    class FixedFormatter:
        value: str

        def __call__(
            self,
            protected_sql: str,
            *,
            triple_quoted: bool,
            options: FormatOptions,
        ) -> str:
            del protected_sql, triple_quoted, options
            return self.value

    result = format_only_candidate(
        'query = r"select 1"',
        sql_formatter=FixedFormatter(formatted),
    )
    assert isinstance(result, CandidateSkip)


@dataclass(slots=True)
class AlternatingFormatter:
    values: tuple[str, str]
    calls: int = 0

    def __call__(
        self,
        protected_sql: str,
        *,
        triple_quoted: bool,
        options: FormatOptions,
    ) -> str:
        del protected_sql, triple_quoted, options
        value = self.values[min(self.calls, 1)]
        self.calls += 1
        return value


def test_non_idempotent_formatter_is_skipped() -> None:
    result = format_only_candidate(
        'query = "select 1"',
        sql_formatter=AlternatingFormatter(("SELECT  1", "SELECT 1")),
    )
    assert isinstance(result, CandidateSkip)
    assert result.reason is ReasonCode.FORMATTER_FAILED


def test_reason_mapping_distinguishes_literal_and_document_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    delimiter_hazard = format_only_candidate(
        'query = r"select 1"',
        sql_formatter=AlternatingFormatter(('SELECT "', 'SELECT "')),
    )
    assert isinstance(delimiter_hazard, CandidateSkip)
    assert delimiter_hazard.reason is ReasonCode.UNSAFE_RAW_STRING

    def fail_analysis(_source: str) -> Never:
        raise SyntaxError

    monkeypatch.setattr(candidate_formatter, "analyze_document", fail_analysis)
    document_failure = format_only_candidate(
        'query = "select 1"',
        sql_formatter=AlternatingFormatter(("SELECT 1", "SELECT 1")),
    )
    assert isinstance(document_failure, CandidateSkip)
    assert document_failure.reason is ReasonCode.FORMATTER_FAILED


@pytest.mark.parametrize("prefix", ["", "r", "f", "rf", "fr"])
@pytest.mark.parametrize("delimiter", ["'", '"', "'''", '"""'])
def test_every_supported_surface_preserves_prefix_and_delimiter(
    prefix: str, delimiter: str
) -> None:
    source = f"query = {prefix}{delimiter}select 1{delimiter}"
    result = format_only_candidate(source)
    assert isinstance(result, CandidateEdit)
    assert result.replacement_text.startswith(prefix + delimiter)
    assert result.replacement_text.endswith(delimiter)


def test_fields_escapes_and_marker_are_preserved_exactly() -> None:
    source = 'query = f"""--sql\r\nselect \\x41 {{value}} {value!r:>{width}}"""'
    result = format_only_candidate(source)
    assert isinstance(result, CandidateEdit)
    updated = apply_candidate_result(source, result)
    assert "--sql\r\n" in updated
    assert r"\x41" in updated
    assert "{{value}}" in updated
    assert "{value!r:>{width}}" in updated
    ast.parse(updated)


def test_formatter_exception_is_skipped() -> None:
    def raising(
        protected_sql: str,
        *,
        triple_quoted: bool,
        options: FormatOptions,
    ) -> str:
        del protected_sql
        del triple_quoted, options
        raise ValueError("formatter failed")

    result = format_only_candidate('query = "select 1"', sql_formatter=raising)
    assert isinstance(result, CandidateSkip)
    assert result.reason is ReasonCode.FORMATTER_FAILED


def test_fixture_file_exists() -> None:
    assert Path("test/fixtures/helper/format-cases.json").is_file()


def test_golden_fixtures_cover_the_formatter_surface() -> None:
    records = json.loads(
        Path("test/fixtures/helper/format-cases.json").read_text(),
    )
    assert isinstance(records, list)
    assert len(records) >= 17
    for record in records:
        assert isinstance(record, dict)
        source = cast(str, record["input"])
        raw_options = cast(dict[str, object], record["options"])
        options = FormatOptions(
            cast(Literal["upper", "lower", "preserve"], raw_options["keywordCase"]),
            cast(int, raw_options["indentWidth"]),
            cast(int, raw_options["wrapAfter"]),
            cast(bool, raw_options["useSpaceAroundOperators"]),
            cast(bool, raw_options["expandSelectList"]),
            cast(bool, raw_options["trimBlankBoundaries"]),
            cast(
                Literal["sql", "mysql", "postgresql", "sqlite"],
                raw_options["dialect"],
            ),
        )
        analysis = analyze_document(source)
        literal = analysis.supported[0]
        result = format_candidate(
            source,
            analysis,
            literal,
            detect_sql(literal, analysis.source_map),
            options,
            nonce=NONCE,
            sql_formatter=format_sql,
        )
        expected_reason = record["reason"]
        if expected_reason is not None:
            assert isinstance(result, CandidateSkip)
            assert result.reason.value == expected_reason
            continue
        assert isinstance(result, (CandidateEdit, CandidateUnchanged))
        assert apply_candidate_result(source, result) == cast(str, record["output"])
