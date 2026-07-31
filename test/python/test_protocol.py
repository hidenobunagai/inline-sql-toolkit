import json
from dataclasses import FrozenInstanceError
from pathlib import Path
from typing import Literal, cast

import pytest
from inline_sql_helper.model import (
    ErrorPayload,
    ErrorResponse,
    FormatMode,
    FormatOptions,
    FormatTarget,
    HelperRequest,
    LocateSuccess,
    Position,
    ProtocolOperation,
    ReasonCode,
    TextRange,
)
from inline_sql_helper.protocol import (
    ProtocolFixtureCase,
    ProtocolValueKind,
    ProtocolViolation,
    error_response,
    parse_protocol_value,
    parse_request_json,
    serialize_request,
    serialize_response,
)

FIXTURE_KINDS = frozenset(
    {"request", "locateResponse", "formatResponse", "preDispatchError"}
)


def require_fixture_dict(
    value: object,
    keys: frozenset[str],
) -> dict[str, object]:
    if not isinstance(value, dict):
        raise AssertionError("invalid protocol fixture object")
    if not all(isinstance(key, str) for key in value):
        raise AssertionError("invalid protocol fixture key")
    record = cast(dict[str, object], value)
    if frozenset(record) != keys:
        raise AssertionError("invalid protocol fixture keys")
    return record


def load_protocol_cases(
    section: Literal["valid", "invalid"],
) -> tuple[ProtocolFixtureCase, ...]:
    decoded: object = json.loads(
        Path("test/fixtures/helper/protocol-cases.json").read_text(encoding="utf-8")
    )
    root = require_fixture_dict(decoded, frozenset({"valid", "invalid"}))
    values = root[section]
    if not isinstance(values, list):
        raise AssertionError("invalid protocol fixture section")
    result: list[ProtocolFixtureCase] = []
    names: set[str] = set()
    for value in values:
        item = require_fixture_dict(
            value,
            frozenset({"name", "kind", "value"}),
        )
        name = item["name"]
        kind = item["kind"]
        if not isinstance(name, str) or name in names or kind not in FIXTURE_KINDS:
            raise AssertionError("invalid protocol fixture case")
        names.add(name)
        result.append(
            ProtocolFixtureCase(
                name,
                cast(ProtocolValueKind, kind),
                item["value"],
            )
        )
    return tuple(result)


def valid_request_json() -> str:
    case = next(case for case in load_protocol_cases("valid") if case.kind == "request")
    return json.dumps(case.value, ensure_ascii=False, separators=(",", ":"))


REQUIRED_INVALID_CASES = frozenset(
    {
        "unknown-request-key",
        "unknown-nested-key",
        "protocol-version-zero",
        "protocol-version-two",
        "negative-cursor-line",
        "reversed-selection-range",
        "empty-selection-range",
        "cursor-mode-missing-cursor",
        "selection-mode-missing-selection",
        "all-mode-with-cursor",
        "indent-width-below-minimum",
        "indent-width-above-maximum",
        "wrap-after-below-minimum",
        "wrap-after-above-maximum",
        "boolean-used-as-integer",
        "integer-used-as-boolean",
        "unsafe-integer-position",
        "invalid-keyword-case",
        "error-response-with-edits",
        "unknown-error-key",
        "invalid-reason-code",
        "locate-error-with-unknown-operation",
        "format-error-with-unknown-operation",
        "predispatch-error-with-format-operation",
        "unknown-operation-locate-success",
        "unknown-operation-format-success",
        "locate-success-with-empty-range",
        "format-response-with-non-string-text",
        "format-response-with-empty-expected-text",
        "overlapping-edit-ranges",
        "changed-count-does-not-match-edits",
        "skipped-count-does-not-match-skips",
        "summary-parts-do-not-equal-selected",
        "selected-exceeds-discovered",
        "unsafe-integer-summary",
    }
)


def test_invalid_fixture_manifest_covers_required_classes() -> None:
    names = {case.name for case in load_protocol_cases("invalid")}
    assert REQUIRED_INVALID_CASES <= names


def test_fixture_case_repr_does_not_expose_protocol_payload() -> None:
    private_source = "secret_query = select customer_email"
    case = ProtocolFixtureCase(
        "private-request",
        "request",
        {"source": private_source},
    )
    assert private_source not in repr(case)


@pytest.mark.parametrize(
    "case", load_protocol_cases("valid"), ids=lambda case: case.name
)
def test_valid_protocol_case_is_accepted(case: ProtocolFixtureCase) -> None:
    parse_protocol_value(case.kind, case.value)


@pytest.mark.parametrize(
    "case", load_protocol_cases("invalid"), ids=lambda case: case.name
)
def test_invalid_protocol_case_is_rejected(case: ProtocolFixtureCase) -> None:
    with pytest.raises(ProtocolViolation, match="^PROTOCOL_ERROR$"):
        parse_protocol_value(case.kind, case.value)


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
def test_nonstandard_json_number_is_rejected(constant: str) -> None:
    payload = valid_request_json().replace("88", constant, 1).encode()
    with pytest.raises(ProtocolViolation, match="^PROTOCOL_ERROR$"):
        parse_request_json(payload)


@pytest.mark.parametrize("payload", [b"", b"{", b"\xff"])
def test_malformed_request_payload_is_rejected_without_content(
    payload: bytes,
) -> None:
    with pytest.raises(ProtocolViolation, match="^PROTOCOL_ERROR$") as caught:
        parse_request_json(payload)
    assert repr(payload) not in str(caught.value)


@pytest.mark.parametrize(
    "source", ["SELECT '日本語'", "SELECT '𝄞'", "SELECT 'e\u0301'"]
)
def test_request_json_round_trips_unicode(
    source: str, capsys: pytest.CaptureFixture[str]
) -> None:
    request = HelperRequest(
        protocol_version=1,
        operation=ProtocolOperation.LOCATE,
        source=source,
        target=FormatTarget(mode=FormatMode.ALL),
        options=FormatOptions("upper", 2, 88, True),
    )
    assert parse_request_json(serialize_request(request)) == request
    captured = capsys.readouterr()
    assert source not in captured.out
    assert source not in captured.err


def test_models_are_frozen_and_slotted() -> None:
    position = Position(0, 0)
    with pytest.raises(FrozenInstanceError):
        setattr(position, "line", 1)
    assert not hasattr(position, "__dict__")


def test_request_parser_constructs_fresh_nested_values() -> None:
    case = next(case for case in load_protocol_cases("valid") if case.kind == "request")
    record = cast(dict[str, object], case.value)
    parsed = parse_protocol_value("request", record)
    assert isinstance(parsed, HelperRequest)
    assert parsed is not record
    assert parsed.target is not record["target"]
    assert parsed.options is not record["options"]


def test_response_serializers_emit_wire_names_and_compact_utf8() -> None:
    locate = LocateSuccess(
        1,
        ProtocolOperation.LOCATE,
        True,
        (TextRange(Position(0, 0), Position(0, 4)),),
    )
    assert serialize_response(locate) == (
        b'{"protocolVersion":1,"operation":"locate","ok":true,'
        b'"candidates":[{"start":{"line":0,"character":0},'
        b'"end":{"line":0,"character":4}}]}'
    )
    error = error_response("unknown", ReasonCode.PROTOCOL_ERROR)
    assert serialize_response(error) == (
        b'{"protocolVersion":1,"operation":"unknown","ok":false,'
        b'"error":{"code":"PROTOCOL_ERROR"}}'
    )


def test_invalid_response_dataclass_is_rejected_without_leaking_text() -> None:
    private_text = "secret_query = select customer_email"
    invalid = ErrorResponse(
        1,
        ProtocolOperation.LOCATE,
        False,
        ErrorPayload(cast(ReasonCode, private_text)),
    )
    with pytest.raises(ProtocolViolation, match="^PROTOCOL_ERROR$") as caught:
        serialize_response(invalid)
    assert private_text not in str(caught.value)
