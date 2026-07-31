"""Run the packaged helper in a network-disabled, read-only container."""

from __future__ import annotations

import argparse
import io
import json
import subprocess
import sys
import tempfile
import zipfile
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import cast

from verify_vsix import ValidatedVsix, VsixError, validate_vsix


class OfflineSmokeError(RuntimeError):
    """A source-free offline smoke failure."""


ProcessRunner = Callable[..., subprocess.CompletedProcess[bytes]]


def extract_validated_vsix(validated: ValidatedVsix, destination: Path) -> Path:
    root = destination.resolve()
    root.mkdir(parents=True, exist_ok=True)
    extracted_bytes = 0
    try:
        with zipfile.ZipFile(io.BytesIO(validated.archive_bytes)) as archive:
            for member in validated.members:
                target = (root / PurePosixPath(member)).resolve()
                if not target.is_relative_to(root):
                    raise VsixError("archive member escapes extraction root")
                target.parent.mkdir(parents=True, exist_ok=True)
                try:
                    info = archive.getinfo(member)
                except KeyError:
                    raise VsixError("required archive member is missing") from None
                written = 0
                with archive.open(info) as source, target.open("xb") as output:
                    while chunk := source.read(1024 * 1024):
                        written += len(chunk)
                        extracted_bytes += len(chunk)
                        if (
                            written > info.file_size
                            or extracted_bytes > validated.expanded_bytes
                        ):
                            raise VsixError("archive extraction size mismatch")
                        output.write(chunk)
                if written != info.file_size:
                    raise VsixError("archive member size mismatch")
    except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
        raise VsixError("invalid archive extraction") from exc
    if extracted_bytes != validated.expanded_bytes:
        raise VsixError("archive expanded size mismatch")
    extension_root = (root / "extension").resolve()
    if not extension_root.is_relative_to(root) or not extension_root.is_dir():
        raise VsixError("invalid extracted extension root")
    return extension_root


def _validate_offline_response(result: subprocess.CompletedProcess[bytes]) -> None:
    if result.returncode != 0:
        raise OfflineSmokeError("offline smoke failed")
    try:
        response = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise OfflineSmokeError("offline smoke returned invalid response") from exc
    if not isinstance(response, dict) or response.get("ok") is not True:
        raise OfflineSmokeError("offline smoke returned invalid response")
    if response.get("operation") != "format":
        raise OfflineSmokeError("offline smoke returned invalid response")
    edits = response.get("edits")
    if not isinstance(edits, list) or not edits:
        raise OfflineSmokeError("offline smoke returned no edits")
    if result.stderr:
        raise OfflineSmokeError("offline smoke wrote diagnostics")


def run_offline_smoke(
    vsix: Path,
    request: bytes,
    image: str,
    runner: ProcessRunner | None = None,
) -> None:
    validated = validate_vsix(vsix)
    with tempfile.TemporaryDirectory(prefix="inline-sql-vsix-") as temporary:
        extension_root = extract_validated_vsix(validated, Path(temporary))
        command = [
            "docker",
            "run",
            "--rm",
            "--pull=never",
            "--network",
            "none",
            "--read-only",
            "-i",
            "--mount",
            f"type=bind,src={extension_root},dst=/extension,readonly",
            image,
            "python",
            "-I",
            "-S",
            "-B",
            "-X",
            "utf8",
            "/extension/python/bootstrap.py",
        ]
        execute = runner if runner is not None else cast(ProcessRunner, subprocess.run)
        try:
            result = execute(
                command,
                input=request,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                shell=False,
                timeout=30,
            )
        except subprocess.TimeoutExpired:
            raise OfflineSmokeError("offline smoke timed out") from None
        except (OSError, ValueError):
            raise OfflineSmokeError("offline smoke could not start") from None
        _validate_offline_response(result)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vsix", type=Path, required=True)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--image", required=True)
    args = parser.parse_args(argv)
    try:
        run_offline_smoke(args.vsix, args.request.read_bytes(), args.image)
    except (OSError, VsixError, OfflineSmokeError):
        sys.stderr.write("offline VSIX smoke failed\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
