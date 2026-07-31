"""Format one detected SQL literal behind source-preserving safety checks."""

from __future__ import annotations

import ast
from dataclasses import dataclass
from typing import Protocol

from inline_sql_helper.detection import SqlDetection, detect_sql
from inline_sql_helper.literals import (
    DocumentAnalysis,
    SupportedLiteral,
    analyze_document,
)
from inline_sql_helper.model import FormatOptions, ReasonCode
from inline_sql_helper.positions import SourceSpan
from inline_sql_helper.protection import (
    UnsafeRestore,
    build_protection_plan,
    restore_protected,
)
from inline_sql_helper.sqlparse_adapter import SqlFormattingError


class SqlFormatter(Protocol):
    """The deliberately small formatter surface used by the candidate gate."""

    def __call__(
        self,
        protected_sql: str,
        *,
        triple_quoted: bool,
        options: FormatOptions,
    ) -> str:
        """Format one protected SQL body without access to the Python source."""


@dataclass(frozen=True, slots=True)
class CandidateEdit:
    """A guarded replacement for one complete Python literal."""

    source_span: SourceSpan
    expected_text: str
    replacement_text: str


@dataclass(frozen=True, slots=True)
class CandidateSkip:
    """A candidate rejected by one stable safety reason."""

    source_span: SourceSpan
    reason: ReasonCode


@dataclass(frozen=True, slots=True)
class CandidateUnchanged:
    """A valid candidate for which formatting produced no source change."""

    source_span: SourceSpan


type CandidateResult = CandidateEdit | CandidateUnchanged | CandidateSkip


class CandidateFailure(Exception):
    """Internal source-free failure carrying the public skip reason."""

    def __init__(self, reason: ReasonCode) -> None:
        self.reason = reason
        super().__init__(reason.value)


def _literal_text(literal: SupportedLiteral, content: str) -> str:
    """Reassemble content with the exact source prefix and quote delimiter."""
    return f"{literal.prefix}{literal.delimiter}{content}{literal.delimiter}"


def _format_once(
    analysis: DocumentAnalysis,
    literal: SupportedLiteral,
    detection: SqlDetection,
    options: FormatOptions,
    nonce: str,
    sql_formatter: SqlFormatter,
) -> str:
    """Protect, format, restore, and wrap one literal exactly once."""
    plan = build_protection_plan(
        analysis.source_map,
        literal,
        detection,
        nonce,
    )
    formatted = sql_formatter(
        plan.protected_sql,
        triple_quoted=len(literal.delimiter) == 3,
        options=options,
    )
    # sqlparse treats the opaque marker comment as a statement and may add a
    # blank line after it on every pass.  Keep the marker's original line
    # boundary canonical so idempotency does not manufacture blank lines.
    for fragment in plan.fragments:
        if not fragment.marker.endswith("\n"):
            continue
        for line_ending in ("\r\n", "\n", "\r"):
            formatted = formatted.replace(
                fragment.marker + line_ending,
                fragment.marker,
                1,
            )
    restored = restore_protected(formatted, plan)
    return _literal_text(literal, restored)


def _replace_source(source: str, span: SourceSpan, replacement: str) -> str:
    """Replace one half-open source span while preserving all surrounding text."""
    return source[: span.start] + replacement + source[span.end :]


def _replacement_literal(
    updated: DocumentAnalysis,
    original: SupportedLiteral,
) -> SupportedLiteral:
    """Find the reparsed literal and require its Python surface identity."""
    matches = [
        item for item in updated.supported if item.span.start == original.span.start
    ]
    if len(matches) != 1:
        raise CandidateFailure(ReasonCode.FORMATTER_FAILED)
    result = matches[0]
    if (result.prefix, result.delimiter, result.kind) != (
        original.prefix,
        original.delimiter,
        original.kind,
    ):
        raise CandidateFailure(ReasonCode.UNSAFE_RAW_STRING)
    return result


def _field_texts(
    analysis: DocumentAnalysis,
    literal: SupportedLiteral,
) -> tuple[str, ...]:
    """Return source spellings of every replacement field."""
    return tuple(analysis.source_map.slice(span) for span in literal.field_spans)


def _validate_replacement_and_idempotency(
    source: str,
    analysis: DocumentAnalysis,
    literal: SupportedLiteral,
    options: FormatOptions,
    nonce: str,
    sql_formatter: SqlFormatter,
    first: str,
) -> None:
    """Parse, reconcile, and format the candidate again with identical inputs."""
    # Parsing the literal independently distinguishes quote/raw hazards from a
    # failure in the surrounding document or formatter itself.
    try:
        ast.parse(first, mode="eval")
    except (SyntaxError, ValueError):
        raise CandidateFailure(ReasonCode.UNSAFE_RAW_STRING) from None

    updated_source = _replace_source(source, literal.span, first)
    try:
        updated_analysis = analyze_document(updated_source)
    except Exception:
        raise CandidateFailure(ReasonCode.FORMATTER_FAILED) from None

    updated_literal = _replacement_literal(updated_analysis, literal)
    if _field_texts(analysis, literal) != _field_texts(
        updated_analysis,
        updated_literal,
    ):
        raise CandidateFailure(ReasonCode.UNSAFE_FSTRING_RESTORE)

    updated_detection = detect_sql(updated_literal, updated_analysis.source_map)
    if not updated_detection.matched:
        raise CandidateFailure(ReasonCode.FORMATTER_FAILED)
    second = _format_once(
        updated_analysis,
        updated_literal,
        updated_detection,
        options,
        nonce,
        sql_formatter,
    )
    if second != first:
        raise CandidateFailure(ReasonCode.FORMATTER_FAILED)


def format_candidate(
    source: str,
    analysis: DocumentAnalysis,
    literal: SupportedLiteral,
    detection: SqlDetection,
    options: FormatOptions,
    *,
    nonce: str,
    sql_formatter: SqlFormatter,
) -> CandidateResult:
    """Return a changed, unchanged, or safely skipped candidate state."""
    expected = analysis.source_map.slice(literal.span)
    if not detection.matched:
        return CandidateSkip(literal.span, ReasonCode.NO_SQL_CANDIDATE)
    try:
        first = _format_once(
            analysis,
            literal,
            detection,
            options,
            nonce,
            sql_formatter,
        )
        _validate_replacement_and_idempotency(
            source,
            analysis,
            literal,
            options,
            nonce,
            sql_formatter,
            first,
        )
    except CandidateFailure as failure:
        return CandidateSkip(literal.span, failure.reason)
    except UnsafeRestore:
        return CandidateSkip(literal.span, ReasonCode.UNSAFE_FSTRING_RESTORE)
    except SqlFormattingError:
        return CandidateSkip(literal.span, ReasonCode.FORMATTER_FAILED)
    except Exception:
        return CandidateSkip(literal.span, ReasonCode.FORMATTER_FAILED)
    if first == expected:
        return CandidateUnchanged(literal.span)
    return CandidateEdit(literal.span, expected, first)
