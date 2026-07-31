"""Protect Python syntax while a SQL formatter rewrites a literal body."""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from enum import StrEnum

from inline_sql_helper.detection import SqlDetection
from inline_sql_helper.literals import LiteralKind, SupportedLiteral
from inline_sql_helper.positions import SourceMap, SourceSpan


class ProtectedKind(StrEnum):
    """Kind of source text replaced by an opaque formatter marker."""

    FIELD = "field"
    ESCAPED_BRACE = "escaped_brace"
    PYTHON_ESCAPE = "python_escape"
    SQL_MARKER = "sql_marker"


class UnsafeRestore(ValueError):
    """A source-free failure to restore protected Python text."""


@dataclass(frozen=True, slots=True)
class ProtectedFragment:
    """One source span replaced by a nonce-bearing marker."""

    kind: ProtectedKind
    ordinal: int
    source_span: SourceSpan
    source_text: str
    marker: str
    required_offset: int | None


@dataclass(frozen=True, slots=True)
class ProtectionPlan:
    """The masked literal body and its exact restoration fragments."""

    nonce: str
    protected_sql: str
    fragments: tuple[ProtectedFragment, ...]


def allocate_nonce(source: str, random_bytes: Callable[[int], bytes]) -> str:
    """Allocate a cryptographic request nonce absent from *source*."""
    for _attempt in range(128):
        candidate = random_bytes(16)
        if len(candidate) != 16:
            raise UnsafeRestore("invalid protection nonce")
        nonce = candidate.hex()
        if nonce not in source:
            return nonce
    raise UnsafeRestore("unable to allocate protection nonce")


def marker_text(
    nonce: str,
    kind: ProtectedKind,
    ordinal: int,
    *,
    sql_comment: bool,
    canonical_newline: bool,
) -> str:
    """Return the stable opaque token used for one protected fragment."""
    token = f"__INLINE_SQL_{nonce}_{kind.name}_{ordinal}__"
    return ("-- " if sql_comment else "") + token + ("\n" if canonical_newline else "")


def _intersects_any(span: SourceSpan, blocked: Sequence[SourceSpan]) -> bool:
    return any(span.start < other.end and other.start < span.end for other in blocked)


def _python_escape_end(source: str, start: int, limit: int) -> int:
    """Return the complete source spelling of an escape at *start*."""
    if start + 1 >= limit or source[start] != "\\":
        raise UnsafeRestore("invalid Python escape boundary")
    next_character = source[start + 1]
    if next_character == "\r" and start + 2 < limit and source[start + 2] == "\n":
        return start + 3
    if next_character in "\r\n":
        return start + 2
    if next_character == "N" and start + 2 < limit and source[start + 2] == "{":
        close = source.find("}", start + 3, limit)
        if close < 0:
            raise UnsafeRestore("unterminated named Python escape")
        return close + 1
    widths = {"x": 2, "u": 4, "U": 8}
    if next_character in widths:
        end = start + 2 + widths[next_character]
        if end > limit:
            raise UnsafeRestore("unterminated fixed-width Python escape")
        return end
    if next_character in "01234567":
        end = start + 2
        while end < min(start + 4, limit) and source[end] in "01234567":
            end += 1
        return end
    return start + 2


@dataclass(frozen=True, slots=True)
class _FragmentSpec:
    kind: ProtectedKind
    source_span: SourceSpan
    sql_comment: bool = False
    canonical_newline: bool = False
    required_offset: int | None = None


def _discover_source_specs(
    source_map: SourceMap,
    literal: SupportedLiteral,
    detection: SqlDetection,
) -> tuple[_FragmentSpec, ...]:
    """Discover protected syntax spans without evaluating Python text."""
    content = literal.content_span
    specs: list[_FragmentSpec] = []
    if detection.marker_span is not None:
        if detection.sql_span is None:
            raise UnsafeRestore("marker detection has no SQL boundary")
        marker_span = SourceSpan(content.start, detection.sql_span.start)
        marker_source = source_map.slice(marker_span)
        specs.append(
            _FragmentSpec(
                ProtectedKind.SQL_MARKER,
                marker_span,
                sql_comment=True,
                canonical_newline=marker_source.endswith(("\r", "\n")),
                required_offset=0,
            )
        )
    specs.extend(
        _FragmentSpec(ProtectedKind.FIELD, span) for span in literal.field_spans
    )
    fixed_spans = [spec.source_span for spec in specs]

    if literal.kind not in {LiteralKind.RAW, LiteralKind.RAW_FSTRING}:
        cursor = content.start
        while cursor < content.end:
            if source_map.text[cursor] != "\\":
                cursor += 1
                continue
            end = _python_escape_end(source_map.text, cursor, content.end)
            span = SourceSpan(cursor, end)
            if not _intersects_any(span, fixed_spans):
                specs.append(_FragmentSpec(ProtectedKind.PYTHON_ESCAPE, span))
            cursor = end

    cursor = content.start
    while cursor + 1 < content.end:
        pair_span = SourceSpan(cursor, cursor + 2)
        pair = source_map.text[pair_span.start : pair_span.end]
        if pair in {"{{", "}}"}:
            overlaps = [
                spec
                for spec in specs
                if _intersects_any(pair_span, (spec.source_span,))
            ]
            if not overlaps:
                specs.append(_FragmentSpec(ProtectedKind.ESCAPED_BRACE, pair_span))
            elif all(spec.kind is ProtectedKind.PYTHON_ESCAPE for spec in overlaps):
                merged = SourceSpan(
                    min(
                        pair_span.start, *(spec.source_span.start for spec in overlaps)
                    ),
                    max(pair_span.end, *(spec.source_span.end for spec in overlaps)),
                )
                specs = [spec for spec in specs if spec not in overlaps]
                specs.append(_FragmentSpec(ProtectedKind.PYTHON_ESCAPE, merged))
            cursor += 2
            continue
        cursor += 1
    return tuple(sorted(specs, key=lambda spec: spec.source_span))


def mask_fragments(
    content: str,
    content_start: int,
    fragments: Sequence[ProtectedFragment],
) -> str:
    """Replace source fragments in order, rejecting overlap or out-of-range spans."""
    pieces: list[str] = []
    cursor = 0
    for fragment in fragments:
        start = fragment.source_span.start - content_start
        end = fragment.source_span.end - content_start
        if start < cursor or end < start or end > len(content):
            raise UnsafeRestore("protected source spans overlap")
        pieces.extend((content[cursor:start], fragment.marker))
        cursor = end
    pieces.append(content[cursor:])
    return "".join(pieces)


def build_protection_plan(
    source_map: SourceMap,
    literal: SupportedLiteral,
    detection: SqlDetection,
    nonce: str,
) -> ProtectionPlan:
    """Build an exact source mask for one detected SQL literal."""
    if (
        not detection.matched
        or detection.sql_span is None
        or re.fullmatch(r"[0-9a-f]{32}", nonce) is None
        or nonce in source_map.text
    ):
        raise UnsafeRestore("invalid protection-plan input")
    if (
        literal.content_span.start < 0
        or literal.content_span.end > len(source_map.text)
        or detection.sql_span.start < literal.content_span.start
        or detection.sql_span.end != literal.content_span.end
    ):
        raise UnsafeRestore("invalid protection-plan span")
    specs = _discover_source_specs(source_map, literal, detection)
    fragments: list[ProtectedFragment] = []
    previous_end = literal.content_span.start
    for ordinal, spec in enumerate(specs):
        span = spec.source_span
        if (
            span.start < previous_end
            or span.start < literal.content_span.start
            or span.end > literal.content_span.end
        ):
            raise UnsafeRestore("protected source spans overlap")
        fragments.append(
            ProtectedFragment(
                kind=spec.kind,
                ordinal=ordinal,
                source_span=span,
                source_text=source_map.slice(span),
                marker=marker_text(
                    nonce,
                    spec.kind,
                    ordinal,
                    sql_comment=spec.sql_comment,
                    canonical_newline=spec.canonical_newline,
                ),
                required_offset=spec.required_offset,
            )
        )
        previous_end = span.end
    frozen = tuple(fragments)
    return ProtectionPlan(
        nonce=nonce,
        protected_sql=mask_fragments(
            source_map.slice(literal.content_span),
            literal.content_span.start,
            frozen,
        ),
        fragments=frozen,
    )


_TOKEN_TEMPLATE = r"__INLINE_SQL_{nonce}_[A-Z_]+_[0-9]+__"


def _marker_token(marker: str, nonce: str) -> str:
    match = re.fullmatch(
        _TOKEN_TEMPLATE.format(nonce=re.escape(nonce)), marker.rstrip("\n")
    )
    if marker.startswith("-- "):
        match = re.fullmatch(
            r"-- " + _TOKEN_TEMPLATE.format(nonce=re.escape(nonce)) + r"\n?",
            marker,
        )
    if match is None:
        raise UnsafeRestore("invalid protected marker")
    return match.group(0).removeprefix("-- ").removesuffix("\n")


def _embedded_in_sql(formatted: str, position: int) -> bool:
    """Return whether a token position is inside an SQL quote/comment."""
    quote: str | None = None
    line_comment = False
    block_comment = False
    index = 0
    while index < position:
        character = formatted[index]
        following = formatted[index + 1] if index + 1 < position else ""
        if line_comment:
            if character in "\r\n":
                line_comment = False
            index += 1
            continue
        if block_comment:
            if character == "*" and following == "/":
                block_comment = False
                index += 2
            else:
                index += 1
            continue
        if quote is not None:
            if character == "\\":
                index += 2
                continue
            if character == quote:
                if index + 1 < position and formatted[index + 1] == quote:
                    index += 2
                else:
                    quote = None
            index += 1
            continue
        if character in "'\"`":
            quote = character
            index += 1
        elif character == "-" and following == "-":
            line_comment = True
            index += 2
        elif character == "/" and following == "*":
            block_comment = True
            index += 2
        else:
            index += 1
    return quote is not None or line_comment or block_comment


def restore_protected(formatted: str, plan: ProtectionPlan) -> str:
    """Restore all protected fragments in one validated ordered scan."""
    if not re.fullmatch(r"[0-9a-f]{32}", plan.nonce):
        raise UnsafeRestore("invalid protection nonce")
    if formatted.count(plan.nonce) != len(plan.fragments):
        raise UnsafeRestore("protection namespace count changed")
    namespace = re.compile(_TOKEN_TEMPLATE.format(nonce=re.escape(plan.nonce)))
    actual_tokens = tuple(match.group(0) for match in namespace.finditer(formatted))
    expected_tokens = tuple(
        _marker_token(fragment.marker, plan.nonce) for fragment in plan.fragments
    )
    if actual_tokens != expected_tokens:
        raise UnsafeRestore("protected marker sequence changed")

    pieces: list[str] = []
    cursor = 0
    for fragment, expected_token in zip(plan.fragments, expected_tokens, strict=True):
        expected_identity = (
            f"__INLINE_SQL_{plan.nonce}_{fragment.kind.name}_{fragment.ordinal}__"
        )
        if expected_token != expected_identity:
            raise UnsafeRestore("protected marker identity changed")
        position = formatted.find(fragment.marker, cursor)
        if position < 0:
            raise UnsafeRestore("protected marker spelling changed")
        token_position = position + (3 if fragment.marker.startswith("-- ") else 0)
        if (
            formatted[token_position : token_position + len(expected_token)]
            != expected_token
        ):
            raise UnsafeRestore("protected marker identity changed")
        if fragment.kind is not ProtectedKind.SQL_MARKER and _embedded_in_sql(
            formatted, token_position
        ):
            raise UnsafeRestore("protected marker embedded in SQL")
        if (
            fragment.required_offset is not None
            and position != fragment.required_offset
        ):
            raise UnsafeRestore("anchored marker moved")
        pieces.extend((formatted[cursor:position], fragment.source_text))
        cursor = position + len(fragment.marker)
    pieces.append(formatted[cursor:])
    restored = "".join(pieces)
    if plan.nonce in restored:
        raise UnsafeRestore("protection namespace remains after restore")
    return restored
