import json
import sys
import tokenize
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast

import pytest
from inline_sql_helper.detection import SqlDetection, detect_sql
from inline_sql_helper.literals import (
    SupportedLiteral,
    UnsupportedLiteral,
    analyze_document,
)
from inline_sql_helper.positions import SourceMap, SourceSpan


@dataclass(frozen=True, slots=True)
class DetectionCase:
    id: str
    kind: Literal["content", "source"]
    content: str | None
    source: str | None
    detection_expected: bool
    format_expectation: Literal[
        "supported",
        "unsupported-skip",
        "ignored",
        "parse-error",
    ]
    grammar_expectation: Literal["sql", "none", "implementation-defined"]
    reason: str


def load_detection_cases() -> tuple[DetectionCase, ...]:
    raw = json.loads(
        Path("test/fixtures/sql-detection.json").read_text(encoding="utf-8")
    )
    runtime_key = f"{sys.version_info.major}.{sys.version_info.minor}"
    cases: list[DetectionCase] = []
    for item in raw:
        overrides = item.get("formatExpectationByPython", {})
        assert set(overrides).issubset({"3.12", "3.13", "3.14"})
        expectation = overrides.get(runtime_key, item["formatExpectation"])
        cases.append(
            DetectionCase(
                id=item["id"],
                kind=item["kind"],
                content=item.get("content"),
                source=item.get("source"),
                detection_expected=item["detectionExpected"],
                format_expectation=expectation,
                grammar_expectation=item["grammarExpectation"],
                reason=item["reason"],
            )
        )
    return tuple(cases)


def parse_only_literal(source: str) -> tuple[SupportedLiteral, SourceMap]:
    analysis = analyze_document(source)
    assert len(analysis.supported) == 1
    return analysis.supported[0], analysis.source_map


@pytest.mark.parametrize("case", load_detection_cases(), ids=lambda case: case.id)
def test_shared_detection_case(case: DetectionCase) -> None:
    source = (
        'query = """' + cast(str, case.content) + '"""'
        if case.kind == "content"
        else cast(str, case.source)
    )
    try:
        analysis = analyze_document(source)
    except (SyntaxError, tokenize.TokenError):
        assert case.format_expectation == "parse-error"
        return
    if case.format_expectation == "parse-error":
        pytest.fail("fixture expected a request-level parse failure")
    units = (*analysis.supported, *analysis.unsupported)
    detections = [
        (literal, detect_sql(literal, analysis.source_map)) for literal in units
    ]
    matches = [literal for literal, detection in detections if detection.matched]
    assert bool(matches) is case.detection_expected
    if case.format_expectation == "supported":
        assert case.detection_expected is True
        assert case.grammar_expectation == "sql"
        supported_matches = [
            (literal, detection)
            for literal, detection in detections
            if detection.matched and isinstance(literal, SupportedLiteral)
        ]
        assert supported_matches
        for literal, detection in supported_matches:
            assert detection.sql_span is not None
            expected_reason = (
                "marker" if case.reason.startswith("marker") else "keyword"
            )
            assert detection.reason == expected_reason
            expected_start = literal.content_span.start
            content = analysis.source_map.slice(literal.content_span)
            if expected_reason == "marker":
                cursor = 0
                for line in content.splitlines(keepends=True):
                    if line.rstrip("\r\n").strip(" \t") == "":
                        cursor += len(line)
                        continue
                    expected_start += cursor + len(line)
                    break
            else:
                expected_start += len(content) - len(content.lstrip(" \t\r\n"))
            assert detection.sql_span == SourceSpan(
                expected_start,
                literal.content_span.end,
            )
    elif case.format_expectation == "unsupported-skip":
        assert case.grammar_expectation == "sql"
        assert matches
        assert all(isinstance(item, UnsupportedLiteral) for item in matches)
    elif case.format_expectation == "ignored":
        assert case.grammar_expectation == "none"
        assert matches == []


def test_unsupported_detection_never_changes_support_status() -> None:
    analysis = analyze_document('query = "SELECT " "1"')
    literal = analysis.unsupported[0]
    detection = detect_sql(literal, analysis.source_map)
    assert detection.matched is True
    assert analysis.supported == ()
    assert detection.reason == "keyword"


@pytest.mark.parametrize(
    ("content", "matched"),
    [
        ("--sql\rSELECT 1", True),
        ("\n \t-- SQL \r\nSELECT 1", True),
        ("--  sql\nSELECT 1", False),
        ("--\tsql\nSELECT 1", False),
    ],
)
def test_marker_boundaries(content: str, matched: bool) -> None:
    literal, source_map = parse_only_literal(
        'query = """' + content + '"""',
    )
    detection = detect_sql(literal, source_map)
    assert detection.matched is matched


def test_lone_cr_does_not_shift_following_token_rows() -> None:
    source = 'query = """--sql\rSELECT 1"""\nother = "SELECT 2"'
    analysis = analyze_document(source)
    assert tuple(
        analysis.source_map.slice(literal.content_span)
        for literal in analysis.supported
    ) == ("--sql\rSELECT 1", "SELECT 2")
    assert all(
        detect_sql(literal, analysis.source_map).matched
        for literal in analysis.supported
    )


@pytest.mark.parametrize("marker", ["--sql", "-- SQL", "-- SQL\t"])
@pytest.mark.parametrize("terminator", ["\n", "\r\n", "\r"])
def test_marker_span_excludes_marker_and_sql_span_starts_after_line(
    marker: str,
    terminator: str,
) -> None:
    literal, source_map = parse_only_literal(
        'query = """\n  ' + marker + terminator + "SELECT 1" + '"""',
    )
    detection = detect_sql(literal, source_map)
    assert detection.matched is True
    assert detection.reason == "marker"
    assert detection.marker_span is not None
    assert source_map.slice(detection.marker_span).casefold().strip() in {
        "--sql",
        "-- sql",
    }
    assert detection.sql_span is not None
    assert source_map.slice(detection.sql_span) == "SELECT 1"
    assert detection.marker_span.end <= detection.sql_span.start


def test_marker_without_sql_tokens_is_still_a_candidate() -> None:
    literal, source_map = parse_only_literal('query = """--sql\n"""')
    detection = detect_sql(literal, source_map)
    assert detection == SqlDetection(
        matched=True,
        marker_span=SourceSpan(
            literal.content_span.start,
            literal.content_span.start + 5,
        ),
        sql_span=SourceSpan(literal.content_span.start + 6, literal.content_span.end),
        reason="marker",
    )


def test_marker_followed_by_sql_comment_preserves_comment_in_sql_span() -> None:
    literal, source_map = parse_only_literal(
        'query = """--sql\n-- explain\nSELECT 1"""',
    )
    detection = detect_sql(literal, source_map)
    assert detection.matched is True
    assert detection.sql_span is not None
    assert source_map.slice(detection.sql_span) == "-- explain\nSELECT 1"


@pytest.mark.parametrize(
    "keyword",
    [
        "select",
        "with",
        "insert",
        "update",
        "delete",
        "merge",
        "create",
        "alter",
        "drop",
        "truncate",
        "explain",
    ],
)
def test_all_approved_keywords_are_candidates(keyword: str) -> None:
    literal, source_map = parse_only_literal(f'query = "{keyword} value"')
    detection = detect_sql(literal, source_map)
    assert detection.matched is True
    assert detection.reason == "keyword"
    assert detection.marker_span is None
    assert detection.sql_span == literal.content_span


@pytest.mark.parametrize(
    "content",
    [
        "SELECTED value",
        "SELECT_value",
        "SELECTé value",
        "-- explanatory comment\nSELECT 1",
        "Please select one of these values",
    ],
)
def test_keyword_requires_ascii_word_boundary_and_first_token(content: str) -> None:
    literal, source_map = parse_only_literal(
        'query = """' + content + '"""',
    )
    assert detect_sql(literal, source_map).matched is False


def test_escape_spelling_is_not_physical_whitespace() -> None:
    literal, source_map = parse_only_literal(r'query = r"\nSELECT 1"')
    assert detect_sql(literal, source_map).matched is False


def test_unsupported_bytes_and_templates_never_become_candidates() -> None:
    for source in ('query = b"SELECT 1"', 'query = rB"SELECT 1"'):
        analysis = analyze_document(source)
        assert len(analysis.unsupported) == 1
        assert detect_sql(analysis.unsupported[0], analysis.source_map).matched is False


def test_detection_never_evaluates_literal_escapes() -> None:
    literal, source_map = parse_only_literal(r'query = r"\twith value"')
    result = detect_sql(literal, source_map)
    assert result.matched is False
