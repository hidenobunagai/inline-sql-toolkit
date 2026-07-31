"""Security and reproducibility tests for the sqlparse vendor tool."""

from __future__ import annotations

import hashlib
import stat
import sys
import zipfile
from collections.abc import Callable
from pathlib import Path, PurePosixPath

import pytest

sys.path.insert(0, str(Path("tools").resolve()))

from vendor_sqlparse import (  # ty: ignore[unresolved-import]
    VendorError,
    checked_destination,
    validate_archive,
    validate_lock_projection,
    validated_members,
    verify_tree_hashes,
)


def write_synthetic_wheel(root: Path, members: dict[str, bytes]) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    wheel = root / "synthetic.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        for name, payload in members.items():
            archive.writestr(name, payload)
    return wheel


def valid_members() -> dict[str, bytes]:
    return {
        "sqlparse/__init__.py": b'__version__ = "0.5.5"\n',
        "sqlparse/core.py": b"def format(sql, **options):\n    return sql\n",
        "sqlparse-0.5.5.dist-info/METADATA": (
            b"Metadata-Version: 2.1\nName: sqlparse\nVersion: 0.5.5\n"
        ),
        "sqlparse-0.5.5.dist-info/licenses/LICENSE": b"BSD\n",
    }


@pytest.mark.parametrize(
    "member",
    [
        "../escape.py",
        "/absolute.py",
        "other/package.py",
        r"sqlparse\x\..\..\escape.py",
    ],
)
def test_vendor_rejects_unsafe_wheel_member(tmp_path: Path, member: str) -> None:
    wheel = write_synthetic_wheel(
        tmp_path,
        {
            "sqlparse/__init__.py": b'__version__ = "0.5.5"\n',
            "sqlparse-0.5.5.dist-info/METADATA": b"Version: 0.5.5\n",
            member: b"unsafe\n",
        },
    )
    with pytest.raises(VendorError):
        with zipfile.ZipFile(wheel) as archive:
            validated_members(archive)


def test_destination_rejects_backslash_and_escape(tmp_path: Path) -> None:
    staging = tmp_path / "staging"
    staging.mkdir()
    for member in (r"sqlparse\evil.py", "../outside.py", "/absolute.py"):
        with pytest.raises(VendorError):
            checked_destination(staging, member)
    assert tuple(tmp_path.iterdir()) == (staging,)


def test_duplicate_archive_member_is_rejected(tmp_path: Path) -> None:
    wheel = tmp_path / "duplicate.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr("sqlparse/__init__.py", b"one")
        archive.writestr("sqlparse/__init__.py", b"two")
    with pytest.raises(VendorError):
        with zipfile.ZipFile(wheel) as archive:
            validated_members(archive)


def test_symlink_archive_member_is_rejected(tmp_path: Path) -> None:
    wheel = tmp_path / "symlink.whl"
    info = zipfile.ZipInfo("sqlparse/link.py")
    info.external_attr = stat.S_IFLNK << 16
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr(info, b"target")
    with pytest.raises(VendorError):
        with zipfile.ZipFile(wheel) as archive:
            validated_members(archive)


@pytest.mark.parametrize(
    ("name", "mutate"),
    [
        ("missing-init", lambda members: members.pop("sqlparse/__init__.py")),
        (
            "missing-license",
            lambda members: members.pop("sqlparse-0.5.5.dist-info/licenses/LICENSE"),
        ),
        (
            "wrong-version",
            lambda members: members.update(
                {
                    "sqlparse/__init__.py": b'__version__ = "9.9.9"\n',
                    "sqlparse-0.5.5.dist-info/METADATA": b"Version: 9.9.9\n",
                }
            ),
        ),
        (
            "unexpected-top-level",
            lambda members: members.update({"other/package.py": b"bad\n"}),
        ),
    ],
)
def test_archive_metadata_is_strict(
    tmp_path: Path,
    name: str,
    mutate: Callable[[dict[str, bytes]], None],
) -> None:
    members = valid_members()
    mutate(members)
    wheel = write_synthetic_wheel(tmp_path / name, members)
    with zipfile.ZipFile(wheel) as archive:
        with pytest.raises(VendorError):
            validate_archive(archive)


def test_archive_hash_mismatch_is_rejected(tmp_path: Path) -> None:
    wheel = write_synthetic_wheel(tmp_path, valid_members())
    digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
    expected = "12a08b3bf3eec877c519589833aed092e2444e68240a3577e8e26148acc7b1ba"
    assert digest != expected
    with pytest.raises(VendorError):
        validate_archive(wheel, expected_sha256=expected)


def test_changed_vendored_file_hash_is_rejected(tmp_path: Path) -> None:
    vendor = tmp_path / "sqlparse"
    vendor.mkdir()
    (vendor / "__init__.py").write_bytes(b"original")
    inventory = {"__init__.py": hashlib.sha256(b"expected").hexdigest()}
    with pytest.raises(VendorError):
        verify_tree_hashes(vendor, inventory)


def test_lock_and_requirements_projection_must_agree(tmp_path: Path) -> None:
    lock = tmp_path / "sqlparse-vendor.lock"
    requirements = tmp_path / "sqlparse-vendor.requirements.txt"
    lock.write_text("name=sqlparse\nversion=0.5.5\n", encoding="utf-8")
    requirements.write_text("sqlparse==0.4.0\n", encoding="utf-8")
    with pytest.raises(VendorError):
        validate_lock_projection(lock, requirements)


def test_checked_destination_uses_posix_components(tmp_path: Path) -> None:
    staging = tmp_path / "staging"
    staging.mkdir()
    destination = checked_destination(staging, "sqlparse/submodule.py")
    assert destination == (staging / PurePosixPath("sqlparse/submodule.py")).resolve()
