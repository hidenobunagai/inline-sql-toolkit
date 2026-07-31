"""Measure the packaged helper on a deterministic 100 KiB Python document.

The benchmark intentionally keeps the generated source in memory and emits only
aggregate timings.  This makes the report safe to upload from CI without
leaking the fixture or any user data.
"""

from __future__ import annotations

import argparse
import ast
import json
import platform
import statistics
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Sequence


class BenchmarkError(RuntimeError):
    """A deterministic benchmark setup, response, or timing failure."""


Clock = Callable[[], float]


@dataclass(frozen=True, slots=True)
class BenchmarkReport:
    document_bytes: int
    samples: tuple[float, ...]
    median_seconds: float
    minimum_seconds: float
    maximum_seconds: float
    python_version: str
    regression_target_met: bool

    def to_json(self) -> dict[str, object]:
        """Return a source-free JSON-compatible aggregate report."""

        return asdict(self)


def build_document(byte_count: int) -> str:
    """Build the exact-size document used by every benchmark sample."""

    prefix = b'query = """SELECT 1'
    suffix = b'"""\n'
    padding = byte_count - len(prefix) - len(suffix)
    if padding < 1:
        raise BenchmarkError("document size is too small")
    payload = prefix + (b" " * padding) + suffix
    document = payload.decode("ascii")
    try:
        ast.parse(document)
    except SyntaxError as exc:
        raise BenchmarkError("generated benchmark document is not parseable") from exc
    if len(document.encode("utf-8")) != byte_count:
        raise BenchmarkError("document byte count mismatch")
    # Keep the fixture honest: this should contain one assignment and one SQL
    # string, rather than accidentally adding another candidate while editing.
    tree = ast.parse(document)
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.Assign):
        raise BenchmarkError("generated benchmark document has unexpected candidates")
    value = tree.body[0].value
    if not isinstance(value, ast.Constant) or not isinstance(value.value, str):
        raise BenchmarkError("generated benchmark document is not a string query")
    return document


def build_format_request(source: str) -> bytes:
    """Encode one compact format request for the production bootstrap."""

    return json.dumps(
        {
            "protocolVersion": 1,
            "operation": "format",
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
    ).encode("utf-8")


def validate_benchmark_response(result: subprocess.CompletedProcess[bytes]) -> None:
    """Require a successful, compact helper response without echo diagnostics."""

    if result.returncode != 0 or result.stderr:
        raise BenchmarkError("benchmark helper failed")
    try:
        response = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BenchmarkError("benchmark helper returned invalid JSON") from exc
    if not isinstance(response, dict) or response.get("ok") is not True:
        raise BenchmarkError("benchmark helper returned an error")
    if response.get("operation") != "format":
        raise BenchmarkError("benchmark helper returned an unexpected operation")
    edits = response.get("edits")
    skips = response.get("skips")
    if not isinstance(edits, list):
        raise BenchmarkError("benchmark helper returned no candidate result")
    if not edits and (not isinstance(skips, list) or not skips):
        raise BenchmarkError("benchmark helper returned no candidate result")


def probe_python_version(python: str) -> str:
    """Return a compact interpreter version for the report."""

    if python == sys.executable:
        return platform.python_version()
    try:
        result = subprocess.run(
            [
                python,
                "-I",
                "-S",
                "-B",
                "-X",
                "utf8",
                "-c",
                "import platform; print(platform.python_version())",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
            check=False,
            shell=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BenchmarkError("cannot probe Python version") from exc
    if result.returncode != 0 or result.stderr:
        raise BenchmarkError("cannot probe Python version")
    version = result.stdout.decode("utf-8").strip()
    if not version or "\n" in version or len(version) > 32:
        raise BenchmarkError("invalid Python version")
    return version


def benchmark(
    python: str,
    bootstrap: Path,
    iterations: int,
    document_bytes: int,
    hard_timeout_seconds: float,
    clock: Clock = time.perf_counter,
) -> BenchmarkReport:
    """Run one warm-up plus ``iterations`` measured helper invocations."""

    if iterations < 1:
        raise BenchmarkError("iterations must be positive")
    if hard_timeout_seconds <= 0:
        raise BenchmarkError("hard timeout must be positive")
    source = build_document(document_bytes)
    request = build_format_request(source)
    durations: list[float] = []
    for index in range(iterations + 1):
        started = clock()
        try:
            result = subprocess.run(
                [
                    python,
                    "-I",
                    "-S",
                    "-B",
                    "-X",
                    "utf8",
                    str(bootstrap),
                ],
                input=request,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=hard_timeout_seconds,
                check=False,
                shell=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise BenchmarkError("benchmark helper exceeded hard timeout") from exc
        except OSError as exc:
            raise BenchmarkError("benchmark helper could not start") from exc
        duration = clock() - started
        if duration > hard_timeout_seconds:
            raise BenchmarkError("benchmark helper exceeded hard timeout")
        validate_benchmark_response(result)
        if index > 0:
            durations.append(duration)
    median = statistics.median(durations)
    return BenchmarkReport(
        document_bytes=document_bytes,
        samples=tuple(durations),
        median_seconds=median,
        minimum_seconds=min(durations),
        maximum_seconds=max(durations),
        python_version=probe_python_version(python),
        regression_target_met=median <= 1.0,
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument(
        "--bootstrap",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "python" / "bootstrap.py",
    )
    parser.add_argument("--iterations", type=int, default=7)
    parser.add_argument("--document-bytes", type=int, default=102_400)
    parser.add_argument("--hard-timeout-seconds", type=float, default=5.0)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        report = benchmark(
            args.python,
            args.bootstrap,
            args.iterations,
            args.document_bytes,
            args.hard_timeout_seconds,
        )
        payload = (
            json.dumps(report.to_json(), sort_keys=True, separators=(",", ":")) + "\n"
        )
        if args.output is None:
            sys.stdout.write(payload)
        else:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(payload, encoding="utf-8")
    except (BenchmarkError, OSError, ValueError):
        sys.stderr.write("benchmark failed\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
