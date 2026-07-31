"""Subprocess and direct-call coverage for the one-shot helper CLI."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from io import BytesIO
from pathlib import Path
from typing import cast

import pytest
from inline_sql_helper import cli
from inline_sql_helper.model import ReasonCode

ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP = ROOT / "python" / "bootstrap.py"


def request(operation: str = "locate", source: str = 'query = "SELECT 1"') -> bytes:
    return json.dumps(
        {
            "protocolVersion": 1,
            "operation": operation,
            "source": source,
            "target": {"mode": "all"},
            "options": {
                "keywordCase": "upper",
                "indentWidth": 2,
                "wrapAfter": 88,
                "useSpaceAroundOperators": True,
            },
        },
        separators=(",", ":"),
    ).encode()


def run_bootstrap(
    payload: bytes,
    *,
    cwd: Path = ROOT,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[bytes]:
    process_env = os.environ.copy()
    process_env.pop("PYTHONPATH", None)
    if env:
        process_env.update(env)
    return subprocess.run(
        [sys.executable, "-I", "-S", "-B", "-X", "utf8", str(BOOTSTRAP)],
        input=payload,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd,
        env=process_env,
        check=False,
    )


def response(result: subprocess.CompletedProcess[bytes]) -> dict[str, object]:
    assert result.stdout
    value = json.loads(result.stdout.decode("utf-8"))
    return cast(dict[str, object], value)


@pytest.mark.parametrize("payload", [b"", b"{", b"\xff", b"{}{}"])
def test_protocol_errors_are_complete_responses_with_zero_exit(payload: bytes) -> None:
    result = run_bootstrap(payload)
    assert result.returncode == 0
    error = cast(dict[str, object], response(result)["error"])
    assert error["code"] == ReasonCode.PROTOCOL_ERROR.value
    assert result.stderr == b""


def test_valid_locate_is_one_compact_response() -> None:
    result = run_bootstrap(request())
    assert result.returncode == 0
    assert response(result)["ok"] is True
    assert b"\n" not in result.stdout
    assert result.stdout == result.stdout.strip()
    assert result.stderr == b""


def test_valid_format_returns_edit_and_keeps_secret_outside_payload() -> None:
    secret = "SECRET_SQL_VALUE_7f5c"
    source = f'query = "select {secret}"'
    result = run_bootstrap(request("format", source))
    value = response(result)
    assert result.returncode == 0
    assert value["ok"] is True
    assert secret in result.stdout.decode()
    assert result.stderr == b""


def test_multi_candidate_wire_edits_are_source_ordered() -> None:
    source = 'first = "select 1"\nsecond = "select 2"\n'
    result = run_bootstrap(request("format", source))
    value = response(result)
    assert result.returncode == 0
    assert value["ok"] is True
    edits = cast(list[dict[str, object]], value["edits"])
    assert len(edits) == 2
    first_range = cast(dict[str, object], edits[0]["range"])
    second_range = cast(dict[str, object], edits[1]["range"])
    first_start = cast(dict[str, object], first_range["start"])
    second_start = cast(dict[str, object], second_range["start"])
    assert first_start["line"] == 0
    assert second_start["line"] == 1


def test_helper_exception_becomes_process_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail(*args: object, **kwargs: object) -> object:
        raise RuntimeError("private formatter detail")

    monkeypatch.setattr(cli, "locate_request", fail)
    value = json.loads(cli.run(request()).decode())
    assert value["ok"] is False
    assert value["operation"] == "locate"
    assert value["error"]["code"] == ReasonCode.PROCESS_FAILED.value
    assert "private" not in cli.run(request()).decode()


def test_input_and_output_limits_are_source_free() -> None:
    too_large = cli.run(b"x" * (cli.MAX_STDIN_BYTES + 1))
    assert (
        json.loads(too_large)["error"]["code"]
        == ReasonCode.RESOURCE_LIMIT_EXCEEDED.value
    )

    response_value = cli.run(request("locate", 'query = "select 1"'))
    assert len(response_value) < cli.MAX_STDOUT_BYTES


def test_read_bounded_reads_at_most_one_extra_byte() -> None:
    with pytest.raises(cli.InputTooLarge):
        cli.read_bounded(__import__("io").BytesIO(b"abcd"), 3)


def test_unexpected_stdin_error_is_a_complete_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Output:
        buffer = BytesIO()

    monkeypatch.setattr(cli.sys, "stdout", Output())

    def fail(*args: object, **kwargs: object) -> bytes:
        raise OSError("private stdin detail")

    monkeypatch.setattr(cli, "read_bounded", fail)
    assert cli.main() == 0
    value = json.loads(Output.buffer.getvalue())
    assert value == {
        "protocolVersion": 1,
        "operation": "unknown",
        "ok": False,
        "error": {"code": ReasonCode.PROCESS_FAILED.value},
    }
