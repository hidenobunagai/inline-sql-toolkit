"""AST/token reconciliation for standalone Python string literals."""

import ast
import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Literal, cast

from inline_sql_helper.model import ReasonCode
from inline_sql_helper.positions import SourceMap, SourceSpan
from inline_sql_helper.token_bundles import (
    StringTokenBundle,
    UnsafeFieldScan,
    UnsupportedStringSyntax,
    scan_fstring_field_spans,
    scan_string_bundles,
    tokenize_source,
)


class LiteralKind(StrEnum):
    """Supported literal surface categories."""

    PLAIN = "plain"
    RAW = "raw"
    FSTRING = "fstring"
    RAW_FSTRING = "raw_fstring"


@dataclass(frozen=True, slots=True)
class SupportedLiteral:
    """One standalone literal whose source surface is supported."""

    span: SourceSpan
    content_span: SourceSpan
    prefix: str
    delimiter: Literal["'", '"', "'''", '"""']
    kind: LiteralKind
    field_spans: tuple[SourceSpan, ...]


@dataclass(frozen=True, slots=True)
class UnsupportedLiteral:
    """One string syntax unit that cannot be handled safely."""

    span: SourceSpan
    detection_content_span: SourceSpan | None
    reason: ReasonCode


@dataclass(frozen=True, slots=True)
class DocumentAnalysis:
    """Parsed document and its source-ordered literal classifications."""

    source_map: SourceMap
    tree: ast.Module
    supported: tuple[SupportedLiteral, ...]
    unsupported: tuple[UnsupportedLiteral, ...]


def split_plain_string(source_text: str, span: SourceSpan) -> SupportedLiteral:
    """Split one approved plain or raw string token into source spans."""
    match = re.fullmatch(
        r"(?i:(?P<prefix>r)?)"
        r"(?P<quote>'''|\"\"\"|'|\")"
        r"(?P<body>[\s\S]*)"
        r"(?P=quote)",
        source_text,
    )
    if match is None:
        raise UnsupportedStringSyntax
    prefix = match.group("prefix") or ""
    quote = cast(Literal["'", '"', "'''", '"""'], match.group("quote"))
    content_start = span.start + len(prefix) + len(quote)
    return SupportedLiteral(
        span=span,
        content_span=SourceSpan(content_start, span.end - len(quote)),
        prefix=prefix,
        delimiter=quote,
        kind=LiteralKind.RAW if prefix.casefold() == "r" else LiteralKind.PLAIN,
        field_spans=(),
    )


class StringNodeCollector(ast.NodeVisitor):
    """Collect AST string envelopes and their enclosing addition state."""

    def __init__(self, source_map: SourceMap) -> None:
        self.source_map = source_map
        self.addition_depth = 0
        self.nodes: list[tuple[ast.expr, SourceSpan, bool]] = []

    def visit_BinOp(self, node: ast.BinOp) -> None:
        """Track every string below nested addition expressions."""
        if isinstance(node.op, ast.Add):
            self.addition_depth += 1
            self.visit(node.left)
            self.visit(node.right)
            self.addition_depth -= 1
            return
        self.generic_visit(node)

    def visit_Constant(self, node: ast.Constant) -> None:
        """Collect string and bytes constants without inspecting their values."""
        if isinstance(node.value, (str, bytes)):
            self.nodes.append((node, self._span(node), self.addition_depth > 0))

    def visit_JoinedStr(self, node: ast.JoinedStr) -> None:
        """Collect one f-string without revisiting its internal constants."""
        self.nodes.append((node, self._span(node), self.addition_depth > 0))

    def visit_TemplateStr(self, node: ast.expr) -> None:
        """Collect one t-string without revisiting its internal constants."""
        self.nodes.append((node, self._span(node), self.addition_depth > 0))

    def _span(self, node: ast.expr) -> SourceSpan:
        end_lineno = node.end_lineno
        end_col_offset = node.end_col_offset
        if end_lineno is None or end_col_offset is None:
            raise ValueError("string node has no source envelope")
        return SourceSpan(
            self.source_map.offset_from_ast(node.lineno, node.col_offset),
            self.source_map.offset_from_ast(end_lineno, end_col_offset),
        )


_STRING_SURFACE = re.compile(
    r"(?is)(?P<prefix>[A-Za-z]*)"
    r"(?P<quote>'''|\"\"\"|'|\")"
    r"(?P<body>[\s\S]*)"
    r"(?P=quote)"
)


def _content_span(
    bundle: StringTokenBundle,
    source_map: SourceMap,
) -> tuple[str, str, SourceSpan] | None:
    matched = _STRING_SURFACE.fullmatch(source_map.slice(bundle.span))
    if matched is None:
        return None
    prefix = matched.group("prefix")
    delimiter = matched.group("quote")
    start = bundle.span.start + len(prefix) + len(delimiter)
    return prefix, delimiter, SourceSpan(start, bundle.span.end - len(delimiter))


def _unsupported(
    span: SourceSpan,
    detection_span: SourceSpan | None,
) -> UnsupportedLiteral:
    return UnsupportedLiteral(
        span=span,
        detection_content_span=detection_span,
        reason=ReasonCode.UNSUPPORTED_LITERAL,
    )


def fstring_kind(prefix: str) -> LiteralKind:
    """Classify one supported case-insensitive f-string prefix."""
    normalized = prefix.casefold()
    if normalized == "f":
        return LiteralKind.FSTRING
    if normalized in {"rf", "fr"}:
        return LiteralKind.RAW_FSTRING
    raise UnsupportedStringSyntax


def direct_ast_field_spans(
    node: ast.JoinedStr,
    source_map: SourceMap,
) -> tuple[SourceSpan, ...]:
    """Return parser-provided top-level replacement-field envelopes."""
    fields: list[SourceSpan] = []
    for value in node.values:
        if not isinstance(value, ast.FormattedValue):
            continue
        end_lineno = value.end_lineno
        end_col_offset = value.end_col_offset
        if end_lineno is None or end_col_offset is None:
            raise UnsafeFieldScan("AST field has no source envelope")
        fields.append(
            SourceSpan(
                source_map.offset_from_ast(value.lineno, value.col_offset),
                source_map.offset_from_ast(end_lineno, end_col_offset),
            )
        )
    return tuple(fields)


def checked_field_spans(
    node: ast.JoinedStr,
    scanned: tuple[SourceSpan, ...],
    source_map: SourceMap,
) -> tuple[SourceSpan, ...]:
    """Accept scanned fields only when their parser envelopes are identical."""
    if direct_ast_field_spans(node, source_map) != scanned:
        raise UnsafeFieldScan("AST and token field spans differ")
    return scanned


def classify_fstring(
    node: ast.expr,
    bundle: StringTokenBundle,
    source_map: SourceMap,
) -> SupportedLiteral | UnsupportedLiteral:
    """Promote one exactly reconciled f-string or return one safe skip unit."""
    surface = _content_span(bundle, source_map)
    if (
        bundle.kind != "fstring"
        or surface is None
        or not isinstance(node, ast.JoinedStr)
    ):
        return _unsupported(bundle.span, None)
    prefix, delimiter, content_span = surface
    try:
        kind = fstring_kind(prefix)
        scanned = scan_fstring_field_spans(bundle, source_map)
        fields = checked_field_spans(node, scanned, source_map)
    except UnsupportedStringSyntax:
        return _unsupported(bundle.span, None)
    except UnsafeFieldScan:
        return UnsupportedLiteral(
            span=bundle.span,
            detection_content_span=content_span,
            reason=ReasonCode.UNSAFE_FSTRING_RESTORE,
        )
    return SupportedLiteral(
        span=bundle.span,
        content_span=content_span,
        prefix=prefix,
        delimiter=cast(
            Literal["'", '"', "'''", '"""'],
            delimiter,
        ),
        kind=kind,
        field_spans=fields,
    )


def analyze_document(source: str) -> DocumentAnalysis:
    """Parse one complete document and collect plain-string syntax units."""
    source_map = SourceMap.from_text(source)
    tree = ast.parse(source)
    bundles = scan_string_bundles(tokenize_source(source, source_map))
    collector = StringNodeCollector(source_map)
    collector.visit(tree)
    supported: list[SupportedLiteral] = []
    unsupported: list[UnsupportedLiteral] = []
    consumed: set[int] = set()
    for node, node_span, below_addition in collector.nodes:
        owned = [
            (index, bundle)
            for index, bundle in enumerate(bundles)
            if node_span.start <= bundle.span.start and bundle.span.end <= node_span.end
        ]
        consumed.update(index for index, _bundle in owned)
        if isinstance(node, ast.Constant) and isinstance(node.value, bytes):
            unsupported.append(_unsupported(node_span, None))
            continue
        if any(bundle.kind == "tstring" for _index, bundle in owned):
            unsupported.append(_unsupported(node_span, None))
            continue
        surfaces = [
            surface
            for _index, bundle in owned
            if (surface := _content_span(bundle, source_map)) is not None
        ]
        detection_span = (
            surfaces[0][2] if surfaces and surfaces[0][0].casefold() != "u" else None
        )
        if below_addition or len(owned) != 1:
            unsupported.append(_unsupported(node_span, detection_span))
            continue
        bundle = owned[0][1]
        if bundle.kind == "fstring":
            classified = classify_fstring(node, bundle, source_map)
            if isinstance(classified, SupportedLiteral):
                supported.append(classified)
            else:
                unsupported.append(classified)
            continue
        surface = _content_span(bundle, source_map)
        if surface is None:
            unsupported.append(_unsupported(node_span, None))
            continue
        prefix, _delimiter, _content = surface
        if prefix.casefold() == "u" or "b" in prefix.casefold():
            unsupported.append(_unsupported(node_span, None))
            continue
        try:
            supported.append(
                split_plain_string(source_map.slice(bundle.span), bundle.span)
            )
        except UnsupportedStringSyntax:
            unsupported.append(_unsupported(node_span, None))
    for index, bundle in enumerate(bundles):
        if index not in consumed and bundle.kind == "tstring":
            unsupported.append(_unsupported(bundle.span, None))
    return DocumentAnalysis(
        source_map=source_map,
        tree=tree,
        supported=tuple(sorted(supported, key=lambda item: item.span)),
        unsupported=tuple(sorted(unsupported, key=lambda item: item.span)),
    )
