"""Document-level locate and formatting behavior."""

from __future__ import annotations

from dataclasses import dataclass

import pytest
from inline_sql_helper.candidate_formatter import SqlFormatter
from inline_sql_helper.engine import (
    MAX_CANDIDATE_BYTES,
    MAX_CANDIDATES,
    MAX_DOCUMENT_BYTES,
    EngineDependencies,
    format_request,
    locate_request,
)
from inline_sql_helper.model import (
    ErrorResponse,
    FormatMode,
    FormatOptions,
    FormatSuccess,
    FormatTarget,
    HelperRequest,
    LocateSuccess,
    Position,
    ProtocolOperation,
    ReasonCode,
    TextRange,
)
from inline_sql_helper.protocol import ProtocolViolation, parse_target
from inline_sql_helper.sqlparse_adapter import format_sql

OPTIONS = FormatOptions("upper", 2, 88, True)


def request(
    source: str,
    *,
    mode: FormatMode = FormatMode.ALL,
    cursor: Position | None = None,
    selection: TextRange | None = None,
    operation: ProtocolOperation = ProtocolOperation.FORMAT,
) -> HelperRequest:
    return HelperRequest(
        1,
        operation,
        source,
        FormatTarget(mode, cursor=cursor, selection=selection),
        OPTIONS,
    )


@dataclass
class CountingFormatter:
    calls: int = 0

    def __call__(
        self,
        protected_sql: str,
        *,
        triple_quoted: bool,
        options: FormatOptions,
    ) -> str:
        self.calls += 1
        return format_sql(protected_sql, triple_quoted=triple_quoted, options=options)


def deps(formatter: SqlFormatter | None = None) -> EngineDependencies:
    return EngineDependencies(lambda size: b"a" * size, formatter or format_sql)


def format_success(value: object) -> FormatSuccess:
    assert isinstance(value, FormatSuccess)
    return value


def locate_success(value: object) -> LocateSuccess:
    assert isinstance(value, LocateSuccess)
    return value


def error_response(value: object) -> ErrorResponse:
    assert isinstance(value, ErrorResponse)
    return value


def test_engine_module_is_not_missing() -> None:
    assert MAX_DOCUMENT_BYTES == 5 * 1024 * 1024
    assert MAX_CANDIDATE_BYTES == 1024 * 1024
    assert MAX_CANDIDATES == 1000


def test_cursor_selects_only_containing_literal() -> None:
    source = 'a = "select 1"\nb = "select 2"\n'
    result = format_success(
        format_request(
            request(source, mode=FormatMode.CURSOR, cursor=Position(0, 6)), deps()
        )
    )
    assert result.ok is True
    assert result.summary.selected == 1
    assert result.summary.discovered == 2
    assert len(result.edits) == 1


def test_selection_expands_to_intersecting_literals() -> None:
    source = 'a = "select 1"\nb = "select 2"\n'
    result = format_success(
        format_request(
            request(
                source,
                mode=FormatMode.SELECTION,
                selection=TextRange(Position(0, 0), Position(1, 8)),
            ),
            deps(),
        )
    )
    assert result.ok is True
    assert result.summary.selected == 2
    assert len(result.edits) == 2
    assert result.edits[0].range.start.line > result.edits[1].range.start.line


def test_empty_selection_is_rejected_by_protocol_model() -> None:
    with pytest.raises(ProtocolViolation):
        parse_target(
            {
                "mode": "selection",
                "selection": {
                    "start": {"line": 0, "character": 0},
                    "end": {"line": 0, "character": 0},
                },
            }
        )


def test_partial_success_skips_unsafe_literal() -> None:
    source = 'safe = "select 1"\nunsafe = b"select 2"\n'
    result = format_success(format_request(request(source), deps()))
    assert result.ok is True
    assert len(result.edits) == 1
    assert len(result.skips) == 0  # bytes are not candidates

    source = 'safe = "select 1"\nunsafe = "select 2" "tail"\n'
    result = format_success(format_request(request(source), deps()))
    assert result.ok is True
    assert len(result.edits) == 1
    assert len(result.skips) == 1
    assert result.skips[0].reason is ReasonCode.UNSUPPORTED_LITERAL


def test_zero_candidate_contract() -> None:
    source = 'value = "plain text"'
    locate = locate_success(
        locate_request(request(source, operation=ProtocolOperation.LOCATE), deps())
    )
    assert locate.ok is True
    assert locate.candidates == ()
    formatted = error_response(format_request(request(source), deps()))
    assert formatted.ok is False
    assert formatted.error.code is ReasonCode.NO_SQL_CANDIDATE


def test_fstring_field_inside_sql_string_is_formatted() -> None:
    source = (
        'user_status = "active"\n'
        "min_age = 20\n"
        "\n"
        'query = f"""--sql\n'
        "SELECT id, {col_name} FROM {table_name} "
        "WHERE status = '{user_status}' AND age > {min_age};\n"
        '"""\n'
    )
    result = format_success(format_request(request(source), deps()))
    assert result.ok is True
    assert result.summary.selected == 1
    assert result.summary.skipped == 0
    assert len(result.edits) == 1
    edit = result.edits[0]
    assert "{col_name}" in edit.new_text
    assert "{table_name}" in edit.new_text
    assert "'{user_status}'" in edit.new_text
    assert "{min_age}" in edit.new_text


def test_marker_only_candidate_is_unchanged() -> None:
    source = 'value = "-- sql"'
    result = format_success(format_request(request(source), deps()))
    assert result.ok is True
    assert result.edits == ()
    assert result.summary == result.summary.__class__(1, 1, 0, 1, 0)


def test_locate_does_not_call_formatter_and_filters_unsupported() -> None:
    formatter = CountingFormatter()
    source = 'safe = "select 1"\nunsafe = "select 2" "tail"\n'
    result = locate_success(
        locate_request(
            request(source, operation=ProtocolOperation.LOCATE), deps(formatter)
        )
    )
    assert result.ok is True
    assert len(result.candidates) == 1
    assert formatter.calls == 0


@pytest.mark.parametrize("source", ["%%sql\nselect 1", "%sql select 1", "!ls", "x = ("])
def test_document_parse_failure_is_source_free(source: str) -> None:
    result = error_response(format_request(request(source), deps()))
    assert result.ok is False
    assert result.error.code is ReasonCode.DOCUMENT_PARSE_FAILED
    assert source not in repr(result)


def test_resource_limits_are_bytes_and_candidate_level() -> None:
    document = "#" * MAX_DOCUMENT_BYTES + "x"
    result = error_response(format_request(request(document), deps()))
    assert result.ok is False
    assert result.error.code is ReasonCode.RESOURCE_LIMIT_EXCEEDED

    huge = "select " + ("x" * MAX_CANDIDATE_BYTES)
    source = f'huge = "{huge}"\nsmall = "select 1"'
    result = format_success(format_request(request(source), deps()))
    assert result.ok is True
    assert result.summary.skipped == 1
    assert len(result.edits) == 1
    assert result.skips[0].reason is ReasonCode.RESOURCE_LIMIT_EXCEEDED


def test_exact_candidate_limit_allowed_and_over_limit_rejected() -> None:
    source = "\n".join(f'x{i} = "select {i}"' for i in range(MAX_CANDIDATES))
    result = locate_success(
        locate_request(request(source, operation=ProtocolOperation.LOCATE), deps())
    )
    assert result.ok is True
    assert len(result.candidates) == MAX_CANDIDATES
    over = source + '\nx1000 = "select 1000"'
    result = error_response(
        locate_request(request(over, operation=ProtocolOperation.LOCATE), deps())
    )
    assert result.ok is False
    assert result.error.code is ReasonCode.RESOURCE_LIMIT_EXCEEDED


def test_content_detector_is_independent_of_call_name() -> None:
    source = (
        'a = mo.sql("select 1")\n'
        'b = pandas.read_sql("select 2", con)\n'
        'c = custom("select 3")\n'
    )
    result = locate_success(
        locate_request(request(source, operation=ProtocolOperation.LOCATE), deps())
    )
    assert result.ok is True
    assert len(result.candidates) == 3


def test_implicit_concat_and_add_are_unsupported_but_bytes_are_invisible() -> None:
    source = (
        'safe = "select 1"\n'
        'concat = "select " "2"\n'
        'added = "select " + "3"\n'
        'blob = b"select 4"\n'
    )
    result = format_success(format_request(request(source), deps()))
    assert result.ok is True
    assert len(result.edits) == 1
    assert len(result.skips) == 2
    assert all(skip.reason is ReasonCode.UNSUPPORTED_LITERAL for skip in result.skips)


def test_same_nonce_is_used_for_all_candidates() -> None:
    nonces: list[bytes] = []

    def random_bytes(size: int) -> bytes:
        nonces.append(b"x" * size)
        return nonces[-1]

    result = format_success(
        format_request(
            request('a = "select 1"\nb = "select 2"'),
            EngineDependencies(random_bytes, format_sql),
        )
    )
    assert result.ok is True
    assert len(nonces) == 1
