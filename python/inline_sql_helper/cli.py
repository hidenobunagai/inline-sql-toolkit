"""One-shot, source-silent protocol entry point for the packaged helper."""

from __future__ import annotations

import secrets
import sys
from typing import BinaryIO, Literal

from inline_sql_helper.engine import (
    EngineDependencies,
    format_request,
    locate_request,
)
from inline_sql_helper.model import (
    HelperResponse,
    ProtocolOperation,
    ReasonCode,
)
from inline_sql_helper.protocol import (
    ProtocolViolation,
    decode_json,
    error_response,
    parse_request,
    serialize_response,
)
from inline_sql_helper.sqlparse_adapter import format_sql

MAX_STDIN_BYTES = 32 * 1024 * 1024
MAX_STDOUT_BYTES = 64 * 1024 * 1024


class InputTooLarge(Exception):
    """The helper input exceeded its fixed byte cap."""


def read_bounded(stream: BinaryIO, limit: int) -> bytes:
    """Read at most ``limit`` bytes and reject a payload that exceeds it."""

    payload = stream.read(limit + 1)
    if len(payload) > limit:
        raise InputTooLarge
    return payload


def peek_operation(
    value: object,
) -> ProtocolOperation | Literal["unknown"]:
    """Retain an operation discriminator when reporting a bad request."""

    if not isinstance(value, dict):
        return "unknown"
    operation = value.get("operation")
    if operation == "locate":
        return ProtocolOperation.LOCATE
    if operation == "format":
        return ProtocolOperation.FORMAT
    return "unknown"


def _process(payload: bytes) -> HelperResponse:
    operation: ProtocolOperation | Literal["unknown"] = "unknown"
    try:
        value = decode_json(payload)
        operation = peek_operation(value)
        request = parse_request(value)
        dependencies = EngineDependencies(
            random_bytes=secrets.token_bytes,
            sql_formatter=format_sql,
        )
        if request.operation is ProtocolOperation.LOCATE:
            return locate_request(request, dependencies)
        return format_request(request, dependencies)
    except ProtocolViolation:
        return error_response(operation, ReasonCode.PROTOCOL_ERROR)
    except Exception:
        return error_response(operation, ReasonCode.PROCESS_FAILED)


def run(payload: bytes) -> bytes:
    """Return exactly one compact UTF-8 JSON response for one request."""

    if len(payload) > MAX_STDIN_BYTES:
        response = error_response("unknown", ReasonCode.RESOURCE_LIMIT_EXCEEDED)
    else:
        response = _process(payload)

    operation = response.operation
    try:
        output = serialize_response(response)
    except Exception:
        output = serialize_response(
            error_response(operation, ReasonCode.PROCESS_FAILED)
        )
    if len(output) > MAX_STDOUT_BYTES:
        output = serialize_response(
            error_response(operation, ReasonCode.RESOURCE_LIMIT_EXCEEDED)
        )
    return output


def main() -> int:
    """Write one protocol response and return zero after protocol startup."""

    try:
        payload = read_bounded(sys.stdin.buffer, MAX_STDIN_BYTES)
    except InputTooLarge:
        output = serialize_response(
            error_response("unknown", ReasonCode.RESOURCE_LIMIT_EXCEEDED)
        )
    else:
        output = run(payload)
    sys.stdout.buffer.write(output)
    sys.stdout.buffer.flush()
    return 0
