"""Document-level discovery, target selection, and safe formatting."""

from __future__ import annotations

import ast
import tokenize
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from inline_sql_helper.candidate_formatter import (
    CandidateEdit,
    CandidateResult,
    CandidateSkip,
    CandidateUnchanged,
    SqlFormatter,
    format_candidate,
)
from inline_sql_helper.detection import SqlDetection, detect_sql
from inline_sql_helper.literals import (
    DocumentAnalysis,
    SupportedLiteral,
    UnsupportedLiteral,
    analyze_document,
)
from inline_sql_helper.model import (
    CandidateSkipPayload,
    ErrorResponse,
    FinalizeRequest,
    FormatEdit,
    FormatMode,
    FormatResponse,
    FormatSuccess,
    FormatSummary,
    HelperRequest,
    LocateResponse,
    LocateSuccess,
    ProtectCandidate,
    ProtectResponse,
    ProtectSuccess,
    ProtocolOperation,
    ReasonCode,
)
from inline_sql_helper.positions import PositionMappingError, SourceMap, SourceSpan
from inline_sql_helper.protection import (
    UnsafeRestore,
    allocate_nonce,
    build_protection_plan,
    restore_protected,
)
from inline_sql_helper.protocol import error_response

MAX_DOCUMENT_BYTES = 5 * 1024 * 1024
MAX_CANDIDATE_BYTES = 1024 * 1024
MAX_CANDIDATES = 1_000


@dataclass(frozen=True, slots=True)
class EngineDependencies:
    """Dependencies kept injectable for deterministic tests and the CLI."""

    random_bytes: Callable[[int], bytes]
    sql_formatter: SqlFormatter


@dataclass(frozen=True, slots=True)
class DetectedUnit:
    """One literal syntax unit whose source content looks like SQL."""

    literal: SupportedLiteral | UnsupportedLiteral
    detection: SqlDetection

    @property
    def span(self) -> SourceSpan:
        return self.literal.span


@dataclass(frozen=True, slots=True)
class PreparedRequest:
    """The one parsed and discovered snapshot used by an operation."""

    analysis: DocumentAnalysis
    discovered: tuple[DetectedUnit, ...]
    selected: tuple[DetectedUnit, ...]


def _discover(analysis: DocumentAnalysis) -> tuple[DetectedUnit, ...]:
    literals: tuple[SupportedLiteral | UnsupportedLiteral, ...] = (
        *analysis.supported,
        *analysis.unsupported,
    )
    units = [
        DetectedUnit(literal, detection)
        for literal in literals
        if (detection := detect_sql(literal, analysis.source_map)).matched
    ]
    return tuple(sorted(units, key=lambda unit: unit.span))


def _select(
    units: Sequence[DetectedUnit],
    request: HelperRequest,
    source_map: SourceMap,
) -> tuple[DetectedUnit, ...]:
    target = request.target
    if target.mode is FormatMode.ALL:
        return tuple(units)
    if target.mode is FormatMode.CURSOR:
        if target.cursor is None:
            raise PositionMappingError("cursor payload is absent")
        cursor = source_map.offset_from_vscode(
            target.cursor.line,
            target.cursor.character,
        )
        return tuple(
            unit for unit in units if unit.span.start <= cursor < unit.span.end
        )
    if target.selection is None:
        raise PositionMappingError("selection payload is absent")
    start = source_map.offset_from_vscode(
        target.selection.start.line,
        target.selection.start.character,
    )
    end = source_map.offset_from_vscode(
        target.selection.end.line,
        target.selection.end.character,
    )
    if end <= start:
        raise PositionMappingError("selection is empty or reversed")
    return tuple(
        unit for unit in units if unit.span.start < end and start < unit.span.end
    )


def _prepare(request: HelperRequest) -> PreparedRequest | ErrorResponse:
    if len(request.source.encode("utf-8")) > MAX_DOCUMENT_BYTES:
        return error_response(request.operation, ReasonCode.RESOURCE_LIMIT_EXCEEDED)
    try:
        analysis = analyze_document(request.source)
        discovered = _discover(analysis)
        if len(discovered) > MAX_CANDIDATES:
            return error_response(request.operation, ReasonCode.RESOURCE_LIMIT_EXCEEDED)
        selected = _select(discovered, request, analysis.source_map)
    except (SyntaxError, tokenize.TokenError):
        return error_response(request.operation, ReasonCode.DOCUMENT_PARSE_FAILED)
    except (PositionMappingError, ValueError):
        return error_response(request.operation, ReasonCode.PROTOCOL_ERROR)
    return PreparedRequest(analysis, discovered, selected)


def _format_unit(
    request: HelperRequest,
    prepared: PreparedRequest,
    unit: DetectedUnit,
    nonce: str,
    dependencies: EngineDependencies,
) -> CandidateResult:
    if isinstance(unit.literal, UnsupportedLiteral):
        return CandidateSkip(unit.span, ReasonCode.UNSUPPORTED_LITERAL)
    literal_text = prepared.analysis.source_map.slice(unit.span)
    if len(literal_text.encode("utf-8")) > MAX_CANDIDATE_BYTES:
        return CandidateSkip(unit.span, ReasonCode.RESOURCE_LIMIT_EXCEEDED)
    return format_candidate(
        request.source,
        prepared.analysis,
        unit.literal,
        unit.detection,
        request.options,
        nonce=nonce,
        sql_formatter=dependencies.sql_formatter,
    )


def _combined_source(source: str, edits: Sequence[CandidateEdit]) -> str:
    result = source
    previous_start = len(source) + 1
    for edit in sorted(edits, key=lambda item: item.source_span.start, reverse=True):
        if edit.source_span.end > previous_start:
            raise ValueError("candidate edits overlap")
        result = (
            result[: edit.source_span.start]
            + edit.replacement_text
            + result[edit.source_span.end :]
        )
        previous_start = edit.source_span.start
    return result


def locate_request(
    request: HelperRequest,
    dependencies: EngineDependencies,
) -> LocateResponse:
    """Return supported candidate ranges without invoking the formatter."""
    del dependencies
    prepared = _prepare(request)
    if isinstance(prepared, ErrorResponse):
        return prepared
    candidates = tuple(
        prepared.analysis.source_map.vscode_range(unit.span)
        for unit in prepared.selected
        if isinstance(unit.literal, SupportedLiteral)
        and len(prepared.analysis.source_map.slice(unit.span).encode("utf-8"))
        <= MAX_CANDIDATE_BYTES
    )
    return LocateSuccess(1, ProtocolOperation.LOCATE, True, candidates)


def protect_request(
    request: HelperRequest,
    dependencies: EngineDependencies,
) -> ProtectResponse:
    """Protect selected SQL candidates and return their masked bodies."""
    prepared = _prepare(request)
    if isinstance(prepared, ErrorResponse):
        return prepared
    if not prepared.selected:
        return error_response(request.operation, ReasonCode.NO_SQL_CANDIDATE)
    try:
        nonce = allocate_nonce(request.source, dependencies.random_bytes)
    except UnsafeRestore:
        return error_response(request.operation, ReasonCode.FORMATTER_FAILED)
    candidates: list[ProtectCandidate] = []
    skipped = 0
    for unit in prepared.selected:
        if isinstance(unit.literal, UnsupportedLiteral):
            skipped += 1
            continue
        literal_text = prepared.analysis.source_map.slice(unit.span)
        if len(literal_text.encode("utf-8")) > MAX_CANDIDATE_BYTES:
            skipped += 1
            continue
        try:
            plan = build_protection_plan(
                prepared.analysis.source_map,
                unit.literal,
                unit.detection,
                nonce,
            )
        except UnsafeRestore:
            skipped += 1
            continue
        candidates.append(
            ProtectCandidate(
                prepared.analysis.source_map.vscode_range(unit.span),
                plan.protected_sql,
                "\n" not in prepared.analysis.source_map.slice(unit.span),
            )
        )
    return ProtectSuccess(
        1, ProtocolOperation.PROTECT, True, nonce, tuple(candidates), skipped
    )


def _literal_text(literal: SupportedLiteral, content: str) -> str:
    """Reassemble a literal with its exact source prefix and delimiter."""
    return f"{literal.prefix}{literal.delimiter}{content}{literal.delimiter}"


def finalize_request(
    request: FinalizeRequest,
    dependencies: EngineDependencies,
) -> FormatResponse:
    """Restore and validate externally formatted SQL into guarded edits."""
    del dependencies
    if len(request.source.encode("utf-8")) > MAX_DOCUMENT_BYTES:
        return error_response(request.operation, ReasonCode.RESOURCE_LIMIT_EXCEEDED)
    try:
        analysis = analyze_document(request.source)
    except (SyntaxError, tokenize.TokenError):
        return error_response(request.operation, ReasonCode.DOCUMENT_PARSE_FAILED)
    edits: list[tuple[SourceSpan, str, str]] = []
    skips: list[CandidateSkipPayload] = []
    unchanged = 0
    for item in request.formatted:
        span = SourceSpan(
            analysis.source_map.offset_from_vscode(
                item.range.start.line,
                item.range.start.character,
            ),
            analysis.source_map.offset_from_vscode(
                item.range.end.line,
                item.range.end.character,
            ),
        )
        literal = next(
            (candidate for candidate in analysis.supported if candidate.span == span),
            None,
        )
        if literal is None:
            skips.append(CandidateSkipPayload(item.range, ReasonCode.FORMATTER_FAILED))
            continue
        detection = detect_sql(literal, analysis.source_map)
        if not detection.matched:
            skips.append(CandidateSkipPayload(item.range, ReasonCode.NO_SQL_CANDIDATE))
            continue
        try:
            plan = build_protection_plan(
                analysis.source_map,
                literal,
                detection,
                request.nonce,
            )
            restored = restore_protected(item.sql, plan)
        except UnsafeRestore:
            skips.append(
                CandidateSkipPayload(item.range, ReasonCode.UNSAFE_FSTRING_RESTORE)
            )
            continue
        expected = analysis.source_map.slice(span)
        replacement = _literal_text(literal, restored)
        if expected == replacement:
            unchanged += 1
            continue
        edits.append((span, expected, replacement))
    combined = request.source
    for edit_span, _, new in sorted(
        edits, key=lambda edit: edit[0].start, reverse=True
    ):
        combined = combined[: edit_span.start] + new + combined[edit_span.end :]
    try:
        ast.parse(combined)
    except (SyntaxError, ValueError, TypeError):
        return error_response(request.operation, ReasonCode.FORMATTER_FAILED)
    result_edits = tuple(
        FormatEdit(
            range=analysis.source_map.vscode_range(edit_span),
            expected_text=expected_text,
            new_text=new_text,
        )
        for edit_span, expected_text, new_text in sorted(
            edits, key=lambda edit: edit[0].start
        )
    )
    return FormatSuccess(
        1,
        ProtocolOperation.FINALIZE,
        True,
        result_edits,
        tuple(skips),
        FormatSummary(
            discovered=len(analysis.supported),
            selected=len(request.formatted),
            changed=len(result_edits),
            unchanged=unchanged,
            skipped=len(skips),
        ),
    )


def format_request(
    request: HelperRequest,
    dependencies: EngineDependencies,
) -> FormatResponse:
    """Format selected SQL literals and return guarded, descending edits."""
    prepared = _prepare(request)
    if isinstance(prepared, ErrorResponse):
        return prepared
    if not prepared.selected:
        return error_response(request.operation, ReasonCode.NO_SQL_CANDIDATE)
    try:
        nonce = allocate_nonce(request.source, dependencies.random_bytes)
    except UnsafeRestore:
        return error_response(request.operation, ReasonCode.FORMATTER_FAILED)

    results = tuple(
        _format_unit(request, prepared, unit, nonce, dependencies)
        for unit in prepared.selected
    )
    candidate_edits = tuple(
        result for result in results if isinstance(result, CandidateEdit)
    )
    try:
        combined = _combined_source(request.source, candidate_edits)
        ast.parse(combined)
    except (SyntaxError, ValueError, TypeError):
        return error_response(request.operation, ReasonCode.FORMATTER_FAILED)

    ordered = tuple(
        sorted(candidate_edits, key=lambda edit: edit.source_span.start, reverse=True)
    )
    source_map = prepared.analysis.source_map
    edits = tuple(
        FormatEdit(
            range=source_map.vscode_range(edit.source_span),
            expected_text=edit.expected_text,
            new_text=edit.replacement_text,
        )
        for edit in ordered
    )
    skips = tuple(
        CandidateSkipPayload(
            range=source_map.vscode_range(result.source_span),
            reason=result.reason,
        )
        for result in results
        if isinstance(result, CandidateSkip)
    )
    return FormatSuccess(
        1,
        ProtocolOperation.FORMAT,
        True,
        edits,
        skips,
        FormatSummary(
            discovered=len(prepared.discovered),
            selected=len(prepared.selected),
            changed=len(edits),
            unchanged=sum(isinstance(result, CandidateUnchanged) for result in results),
            skipped=len(skips),
        ),
    )
