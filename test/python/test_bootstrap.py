"""Process isolation tests for the extension's Python bootstrap."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP = ROOT / "python" / "bootstrap.py"
VENDOR = ROOT / "python" / "vendor"


def make_fake_sqlparse(root: Path, version: str = "99.0.0") -> Path:
    package = root / "fake" / "sqlparse"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text(
        f'__version__ = "{version}"\n', encoding="utf-8"
    )
    return package.parent


def run_bootstrap(
    extension_root: Path = ROOT,
    *,
    env: dict[str, str] | None = None,
    arguments: tuple[str, ...] = ("--self-check",),
) -> subprocess.CompletedProcess[str]:
    command = [
        sys.executable,
        "-I",
        "-S",
        "-B",
        "-X",
        "utf8",
        str(extension_root / "python" / "bootstrap.py"),
        *arguments,
    ]
    process_env = os.environ.copy()
    process_env.pop("PYTHONPATH", None)
    if env:
        process_env.update(env)
    return subprocess.run(
        command,
        cwd=extension_root,
        env=process_env,
        check=False,
        capture_output=True,
        text=True,
    )


def run_bootstrap_bytes(
    extension_root: Path = ROOT,
    *,
    payload: bytes = b"",
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    arguments: tuple[str, ...] = (),
) -> subprocess.CompletedProcess[bytes]:
    command = [
        sys.executable,
        "-I",
        "-S",
        "-B",
        "-X",
        "utf8",
        str(extension_root / "python" / "bootstrap.py"),
        *arguments,
    ]
    process_env = os.environ.copy()
    if env:
        process_env.update(env)
    return subprocess.run(
        command,
        cwd=cwd or extension_root,
        env=process_env,
        input=payload,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


@pytest.mark.skipif(not BOOTSTRAP.exists(), reason="bootstrap is added in Task 9")
def test_bootstrap_ignores_pythonpath(tmp_path: Path) -> None:
    fake_package = make_fake_sqlparse(tmp_path)
    result = run_bootstrap(env={"PYTHONPATH": str(fake_package)})
    assert result.returncode == 0
    assert json.loads(result.stdout) == {
        "ok": True,
        "sqlparseVersion": "0.5.5",
        "vendored": True,
    }
    assert result.stderr == ""


@pytest.mark.skipif(not BOOTSTRAP.exists(), reason="bootstrap is added in Task 9")
def test_bootstrap_writes_no_bytecode(tmp_path: Path) -> None:
    before = set((ROOT / "python").rglob("*.pyc"))
    result = run_bootstrap()
    assert result.returncode == 0
    assert set((ROOT / "python").rglob("*.pyc")) == before


@pytest.mark.skipif(not BOOTSTRAP.exists(), reason="bootstrap is added in Task 9")
def test_bootstrap_rejects_other_invocations_without_traceback() -> None:
    result = run_bootstrap(arguments=("--unexpected",))
    assert result.returncode != 0
    assert result.stderr == ""
    assert "Traceback" not in result.stdout


@pytest.mark.skipif(not BOOTSTRAP.exists(), reason="bootstrap is added in Task 9")
def test_bootstrap_failure_is_source_silent(tmp_path: Path) -> None:
    broken_root = tmp_path / "extension"
    (broken_root / "python" / "vendor").mkdir(parents=True)
    (broken_root / "python" / "bootstrap.py").write_text(
        BOOTSTRAP.read_text(encoding="utf-8"), encoding="utf-8"
    )
    result = run_bootstrap(broken_root)
    assert result.returncode != 0
    assert result.stderr == ""
    assert result.stdout == ""


@pytest.mark.skipif(not BOOTSTRAP.exists(), reason="bootstrap is added in Task 9")
def test_bootstrap_rejects_symlinked_vendor_root(tmp_path: Path) -> None:
    extension = tmp_path / "extension"
    python_root = extension / "python"
    python_root.mkdir(parents=True)
    (python_root / "bootstrap.py").write_text(
        BOOTSTRAP.read_text(encoding="utf-8"), encoding="utf-8"
    )
    outside = tmp_path / "outside"
    shutil.copytree(VENDOR, outside)
    try:
        (python_root / "vendor").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks unavailable")
    result = run_bootstrap(extension)
    assert result.returncode != 0
    assert result.stdout == ""
    assert result.stderr == ""


def test_bootstrap_loads_only_packaged_code(tmp_path: Path) -> None:
    fake_workspace = tmp_path / "workspace"
    fake_workspace.mkdir()
    fake_helper = fake_workspace / "inline_sql_helper"
    fake_helper.mkdir()
    (fake_helper / "__init__.py").write_text(
        "raise RuntimeError('fake helper imported')\n", encoding="utf-8"
    )
    fake_sqlparse = fake_workspace / "sqlparse"
    fake_sqlparse.mkdir()
    (fake_sqlparse / "__init__.py").write_text(
        "__version__ = '99.0.0'\n", encoding="utf-8"
    )
    result = run_bootstrap_bytes(
        payload=(
            b'{"protocolVersion":1,"operation":"locate","source":"query = '
            b'\\"SELECT 1\\"","target":{"mode":"all"},"options":'
            b'{"keywordCase":"upper","indentWidth":2,"wrapAfter":88,'
            b'"useSpaceAroundOperators":true,"expandSelectList":false}}'
        ),
        cwd=fake_workspace,
        env={"PYTHONPATH": str(fake_workspace)},
    )
    assert result.returncode == 0
    assert json.loads(result.stdout)["ok"] is True
    assert result.stderr == b""


def test_bootstrap_failure_is_source_silent_for_corrupt_vendor(tmp_path: Path) -> None:
    broken_root = tmp_path / "extension"
    python_root = broken_root / "python"
    python_root.mkdir(parents=True)
    (python_root / "bootstrap.py").write_text(
        BOOTSTRAP.read_text(encoding="utf-8"), encoding="utf-8"
    )
    (python_root / "vendor").mkdir()
    result = run_bootstrap_bytes(
        broken_root,
        cwd=broken_root,
        payload=b'{"source":"SECRET-SQL"}',
    )
    assert result.returncode == 70
    assert result.stdout == b""
    assert result.stderr == b""
