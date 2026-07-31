"""Contract tests for the deterministic performance benchmark helper."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP = ROOT / "python" / "bootstrap.py"
sys.path.insert(0, str(ROOT))

import pytest  # noqa: E402

from tools import benchmark_helper  # noqa: E402


def test_build_document_is_exact_and_deterministic() -> None:
    first = benchmark_helper.build_document(102_400)
    second = benchmark_helper.build_document(102_400)
    assert first == second
    assert len(first.encode("utf-8")) == 102_400
    assert first.startswith('query = """SELECT 1')
    assert first.endswith('"""\n')
    assert first.count('"""') == 2


def test_build_document_rejects_too_small_payload() -> None:
    with pytest.raises(benchmark_helper.BenchmarkError):
        benchmark_helper.build_document(len(b'query = """SELECT 1') + len(b'"""\n'))


def test_benchmark_runs_warmup_plus_seven_samples_and_reports_median(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []

    def fake_run(*args: object, **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        calls.append({"args": args, **kwargs})
        return subprocess.CompletedProcess(
            ["python"],
            0,
            b'{"ok":true,"operation":"format","edits":[{}]}',
            b"",
        )

    pairs = ((0.0, 0.2), (1.0, 1.4), (2.0, 2.1), (3.0, 3.4))
    pairs += ((4.0, 4.2), (5.0, 5.3), (6.0, 6.5), (7.0, 7.1))
    times = iter(value for pair in pairs for value in pair)
    monkeypatch.setattr(benchmark_helper.subprocess, "run", fake_run)
    monkeypatch.setattr(
        benchmark_helper, "probe_python_version", lambda _python: "3.12.0"
    )

    report = benchmark_helper.benchmark(
        "python3",
        BOOTSTRAP,
        iterations=7,
        document_bytes=102_400,
        hard_timeout_seconds=5.0,
        clock=lambda: next(times),
    )

    assert len(calls) == 8
    assert report.samples == pytest.approx((0.4, 0.1, 0.4, 0.2, 0.3, 0.5, 0.1))
    assert report.document_bytes == 102_400
    assert report.median_seconds == pytest.approx(0.3)
    assert report.minimum_seconds == pytest.approx(0.1)
    assert report.maximum_seconds == pytest.approx(0.5)
    assert report.python_version == "3.12.0"
    assert report.regression_target_met is True
    request = calls[0]["input"]
    assert isinstance(request, bytes)
    assert b'"source"' in request
    assert b'"operation":"format"' in request
    for call in calls:
        assert call["timeout"] == 5.0
        assert call["check"] is False
        assert call["stdout"] is subprocess.PIPE
        assert call["stderr"] is subprocess.PIPE


def test_benchmark_rejects_fake_duration_over_hard_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        benchmark_helper.subprocess,
        "run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess(
            "python", 0, b'{"ok":true,"operation":"format","edits":[{}]}', b""
        ),
    )
    times = iter(value for pair in ((0.0, 0.1), (1.0, 6.1)) for value in pair)
    with pytest.raises(benchmark_helper.BenchmarkError, match="hard timeout"):
        benchmark_helper.benchmark(
            "python3",
            BOOTSTRAP,
            iterations=1,
            document_bytes=102_400,
            hard_timeout_seconds=5.0,
            clock=lambda: next(times),
        )


def test_report_json_is_source_free() -> None:
    report = benchmark_helper.BenchmarkReport(
        document_bytes=102_400,
        samples=(0.2,) * 7,
        median_seconds=0.2,
        minimum_seconds=0.2,
        maximum_seconds=0.2,
        python_version="3.12.0",
        regression_target_met=True,
    )
    encoded = json.dumps(report.to_json(), sort_keys=True)
    assert "SELECT" not in encoded
    assert "query =" not in encoded
    assert "source" not in encoded.lower()
