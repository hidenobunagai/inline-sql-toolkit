"""Strict version-one helper protocol parsing and serialization."""

import itertools
import json
from dataclasses import dataclass, field
from typing import Literal, Never, TypeVar, assert_never, cast

from inline_sql_helper.model import (
    CandidateSkipPayload,
    ErrorPayload,
    ErrorResponse,
    FormatEdit,
    FormatMode,
    FormatOptions,
    FormatResponse,
    FormatSuccess,
    FormatSummary,
    FormatTarget,
    HelperRequest,
    HelperResponse,
    LocateResponse,
    LocateSuccess,
    Position,
    ProtocolOperation,
    ReasonCode,
    TextRange,
)

type ProtocolValueKind = Literal[
    "request",
    "locateResponse",
    "formatResponse",
    "preDispatchError",
]


@dataclass(frozen=True, slots=True)
class ProtocolFixtureCase:
    """One cross-language protocol fixture."""

    name: str
    kind: ProtocolValueKind
    value: object = field(repr=False)


class ProtocolViolation(ValueError):
    """A source-free protocol contract violation."""

    code = ReasonCode.PROTOCOL_ERROR

    def __init__(self) -> None:
        super().__init__(self.code.value)


def require_exact_dict(
    value: object,
    keys: frozenset[str],
) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ProtocolViolation
    if not all(isinstance(key, str) for key in value):
        raise ProtocolViolation
    record = {str(key): item for key, item in value.items()}
    if frozenset(record) != keys:
        raise ProtocolViolation
    return record


def require_non_negative_int(value: object) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > 9_007_199_254_740_991
    ):
        raise ProtocolViolation
    return value


TScalar = TypeVar("TScalar", str, int, bool)


def require_literal(value: object, expected: TScalar) -> TScalar:
    if type(value) is not type(expected) or value != expected:
        raise ProtocolViolation
    return expected


def require_str(value: object) -> str:
    if not isinstance(value, str):
        raise ProtocolViolation
    return value


def require_enum(value: object, allowed: set[str]) -> str:
    result = require_str(value)
    if result not in allowed:
        raise ProtocolViolation
    return result


def require_reason(value: object) -> str:
    result = require_str(value)
    if result not in {reason.value for reason in ReasonCode}:
        raise ProtocolViolation
    return result


def require_list(value: object) -> list[object]:
    if not isinstance(value, list):
        raise ProtocolViolation
    return cast(list[object], value)


def compare_position(left: Position, right: Position) -> int:
    left_key = (left.line, left.character)
    right_key = (right.line, right.character)
    return (left_key > right_key) - (left_key < right_key)


def parse_position(value: object) -> Position:
    record = require_exact_dict(value, frozenset({"line", "character"}))
    return Position(
        line=require_non_negative_int(record["line"]),
        character=require_non_negative_int(record["character"]),
    )


def parse_range(value: object, *, allow_empty: bool = True) -> TextRange:
    record = require_exact_dict(value, frozenset({"start", "end"}))
    result = TextRange(
        parse_position(record["start"]),
        parse_position(record["end"]),
    )
    order = compare_position(result.start, result.end)
    if order > 0 or (order == 0 and not allow_empty):
        raise ProtocolViolation
    return result


def parse_format_options(value: object) -> FormatOptions:
    record = require_exact_dict(
        value,
        frozenset(
            {
                "keywordCase",
                "indentWidth",
                "wrapAfter",
                "useSpaceAroundOperators",
                "expandSelectList",
                "trimBlankBoundaries",
            }
        ),
    )
    keyword_case = require_enum(
        record["keywordCase"],
        {"upper", "lower", "preserve"},
    )
    indent_width = require_non_negative_int(record["indentWidth"])
    wrap_after = require_non_negative_int(record["wrapAfter"])
    spacing = record["useSpaceAroundOperators"]
    expand = record["expandSelectList"]
    trim = record["trimBlankBoundaries"]
    if (
        not 1 <= indent_width <= 8
        or not 20 <= wrap_after <= 500
        or not isinstance(spacing, bool)
        or not isinstance(expand, bool)
        or not isinstance(trim, bool)
    ):
        raise ProtocolViolation
    return FormatOptions(
        cast(Literal["upper", "lower", "preserve"], keyword_case),
        indent_width,
        wrap_after,
        spacing,
        expand,
        trim,
    )


def parse_target(value: object) -> FormatTarget:
    if not isinstance(value, dict):
        raise ProtocolViolation
    mode = value.get("mode")
    if mode == "cursor":
        record = require_exact_dict(
            value,
            frozenset({"mode", "cursor"}),
        )
        return FormatTarget(
            FormatMode.CURSOR,
            cursor=parse_position(record["cursor"]),
        )
    if mode == "selection":
        record = require_exact_dict(
            value,
            frozenset({"mode", "selection"}),
        )
        selection = parse_range(record["selection"], allow_empty=False)
        return FormatTarget(FormatMode.SELECTION, selection=selection)
    record = require_exact_dict(value, frozenset({"mode"}))
    if record["mode"] != "all":
        raise ProtocolViolation
    return FormatTarget(FormatMode.ALL)


def parse_request(value: object) -> HelperRequest:
    """Validate one decoded request and construct frozen model values."""

    record = require_exact_dict(
        value,
        frozenset({"protocolVersion", "operation", "source", "target", "options"}),
    )
    return HelperRequest(
        protocol_version=cast(
            Literal[1], require_literal(record["protocolVersion"], 1)
        ),
        operation=ProtocolOperation(
            require_enum(record["operation"], {"locate", "format"})
        ),
        source=require_str(record["source"]),
        target=parse_target(record["target"]),
        options=parse_format_options(record["options"]),
    )


def parse_error_response(
    value: object,
    operation: ProtocolOperation | Literal["unknown"],
) -> ErrorResponse:
    record = require_exact_dict(
        value,
        frozenset({"protocolVersion", "operation", "ok", "error"}),
    )
    error = require_exact_dict(record["error"], frozenset({"code"}))
    if record["operation"] != operation or record["ok"] is not False:
        raise ProtocolViolation
    return ErrorResponse(
        protocol_version=cast(
            Literal[1], require_literal(record["protocolVersion"], 1)
        ),
        operation=operation,
        ok=False,
        error=ErrorPayload(ReasonCode(require_reason(error["code"]))),
    )


def parse_edit(value: object) -> FormatEdit:
    record = require_exact_dict(
        value,
        frozenset({"range", "expectedText", "newText"}),
    )
    expected = require_str(record["expectedText"])
    if not expected:
        raise ProtocolViolation
    return FormatEdit(
        parse_range(record["range"], allow_empty=False),
        expected,
        require_str(record["newText"]),
    )


def parse_skip(value: object) -> CandidateSkipPayload:
    record = require_exact_dict(
        value,
        frozenset({"range", "reason"}),
    )
    return CandidateSkipPayload(
        parse_range(record["range"], allow_empty=False),
        ReasonCode(require_reason(record["reason"])),
    )


def parse_summary(value: object) -> FormatSummary:
    record = require_exact_dict(
        value,
        frozenset({"discovered", "selected", "changed", "unchanged", "skipped"}),
    )
    return FormatSummary(
        require_non_negative_int(record["discovered"]),
        require_non_negative_int(record["selected"]),
        require_non_negative_int(record["changed"]),
        require_non_negative_int(record["unchanged"]),
        require_non_negative_int(record["skipped"]),
    )


def parse_locate_response(value: object) -> LocateResponse:
    if isinstance(value, dict) and value.get("ok") is False:
        return parse_error_response(value, ProtocolOperation.LOCATE)
    record = require_exact_dict(
        value,
        frozenset({"protocolVersion", "operation", "ok", "candidates"}),
    )
    if record["operation"] != "locate" or record["ok"] is not True:
        raise ProtocolViolation
    return LocateSuccess(
        cast(Literal[1], require_literal(record["protocolVersion"], 1)),
        ProtocolOperation.LOCATE,
        True,
        tuple(
            parse_range(item, allow_empty=False)
            for item in require_list(record["candidates"])
        ),
    )


def parse_format_response(value: object) -> FormatResponse:
    if isinstance(value, dict) and value.get("ok") is False:
        return parse_error_response(value, ProtocolOperation.FORMAT)
    record = require_exact_dict(
        value,
        frozenset(
            {
                "protocolVersion",
                "operation",
                "ok",
                "edits",
                "skips",
                "summary",
            }
        ),
    )
    if record["operation"] != "format" or record["ok"] is not True:
        raise ProtocolViolation
    return FormatSuccess(
        cast(Literal[1], require_literal(record["protocolVersion"], 1)),
        ProtocolOperation.FORMAT,
        True,
        tuple(parse_edit(item) for item in require_list(record["edits"])),
        tuple(parse_skip(item) for item in require_list(record["skips"])),
        parse_summary(record["summary"]),
    )


def validate_ordered_non_overlapping_edits(response: FormatSuccess) -> None:
    for previous, current in itertools.pairwise(response.edits):
        if compare_position(current.range.start, previous.range.end) < 0:
            raise ProtocolViolation


def validate_format_relations(response: FormatSuccess) -> FormatSuccess:
    summary = response.summary
    if (
        len(response.edits) != summary.changed
        or len(response.skips) != summary.skipped
        or summary.changed + summary.unchanged + summary.skipped != summary.selected
        or summary.selected > summary.discovered
    ):
        raise ProtocolViolation
    return response


def parse_protocol_value(
    kind: ProtocolValueKind,
    value: object,
) -> HelperRequest | LocateResponse | FormatResponse:
    """Validate one request or context-specific response value."""

    if kind == "request":
        return parse_request(value)
    if kind == "preDispatchError":
        return parse_error_response(value, "unknown")
    if kind == "locateResponse":
        return parse_locate_response(value)
    if kind == "formatResponse":
        response = parse_format_response(value)
        if isinstance(response, ErrorResponse):
            return response
        validate_ordered_non_overlapping_edits(response)
        return validate_format_relations(response)
    assert_never(kind)


def reject_json_constant(_value: str) -> Never:
    raise ProtocolViolation


def decode_json(payload: bytes) -> object:
    try:
        text = payload.decode("utf-8", errors="strict")
        return json.loads(text, parse_constant=reject_json_constant)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ProtocolViolation from None


def range_to_wire(value: TextRange) -> dict[str, object]:
    return {
        "start": {
            "line": value.start.line,
            "character": value.start.character,
        },
        "end": {
            "line": value.end.line,
            "character": value.end.character,
        },
    }


def request_to_wire(request: HelperRequest) -> dict[str, object]:
    target: dict[str, object] = {"mode": request.target.mode.value}
    if request.target.cursor is not None:
        target["cursor"] = {
            "line": request.target.cursor.line,
            "character": request.target.cursor.character,
        }
    if request.target.selection is not None:
        target["selection"] = range_to_wire(request.target.selection)
    return {
        "protocolVersion": request.protocol_version,
        "operation": request.operation.value,
        "source": request.source,
        "target": target,
        "options": {
            "keywordCase": request.options.keyword_case,
            "indentWidth": request.options.indent_width,
            "wrapAfter": request.options.wrap_after,
            "useSpaceAroundOperators": (request.options.use_space_around_operators),
            "expandSelectList": request.options.expand_select_list,
            "trimBlankBoundaries": request.options.trim_blank_boundaries,
        },
    }


def response_to_wire(response: HelperResponse) -> dict[str, object]:
    operation = (
        response.operation
        if response.operation == "unknown"
        else response.operation.value
    )
    if isinstance(response, ErrorResponse):
        return {
            "protocolVersion": response.protocol_version,
            "operation": operation,
            "ok": response.ok,
            "error": {"code": response.error.code.value},
        }
    if isinstance(response, LocateSuccess):
        return {
            "protocolVersion": response.protocol_version,
            "operation": operation,
            "ok": response.ok,
            "candidates": [
                range_to_wire(candidate) for candidate in response.candidates
            ],
        }
    # Candidate formatting applies edits from the end of the source backwards
    # so source offsets remain stable. The wire protocol, however, requires
    # edits in source order. Sort only this serialized view: the internal
    # FormatSuccess contract remains descending for the atomic applicator and
    # malformed descending payloads are still rejected by the parser.
    ordered_edits = sorted(
        response.edits,
        key=lambda edit: (edit.range.start.line, edit.range.start.character),
    )
    return {
        "protocolVersion": response.protocol_version,
        "operation": operation,
        "ok": response.ok,
        "edits": [
            {
                "range": range_to_wire(edit.range),
                "expectedText": edit.expected_text,
                "newText": edit.new_text,
            }
            for edit in ordered_edits
        ],
        "skips": [
            {
                "range": range_to_wire(skip.range),
                "reason": skip.reason.value,
            }
            for skip in response.skips
        ],
        "summary": {
            "discovered": response.summary.discovered,
            "selected": response.summary.selected,
            "changed": response.summary.changed,
            "unchanged": response.summary.unchanged,
            "skipped": response.summary.skipped,
        },
    }


def encode_json(value: object) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError):
        raise ProtocolViolation from None


def parse_request_json(payload: bytes) -> HelperRequest:
    """Decode strict UTF-8 and validate one JSON request."""

    return parse_request(decode_json(payload))


def serialize_request(request: HelperRequest) -> bytes:
    """Serialize compact UTF-8 JSON for cross-language round-trip tests."""

    try:
        value = request_to_wire(request)
    except (AttributeError, TypeError, ValueError):
        raise ProtocolViolation from None
    validated = parse_request(value)
    return encode_json(request_to_wire(validated))


def serialize_response(response: HelperResponse) -> bytes:
    """Serialize exactly one compact UTF-8 JSON response."""

    try:
        value = response_to_wire(response)
        kind: ProtocolValueKind = (
            "locateResponse"
            if response.operation == ProtocolOperation.LOCATE
            else "formatResponse"
            if response.operation == ProtocolOperation.FORMAT
            else "preDispatchError"
        )
    except (AttributeError, TypeError, ValueError):
        raise ProtocolViolation from None
    parse_protocol_value(kind, value)
    return encode_json(value)


def error_response(
    operation: ProtocolOperation | Literal["unknown"],
    code: ReasonCode,
) -> ErrorResponse:
    """Construct a source-free request error."""

    return ErrorResponse(1, operation, False, ErrorPayload(code))
