"""Security and reproducibility tests for the sqlparse vendor tool."""

from __future__ import annotations

import hashlib
import json
import shutil
import stat
import sys
import zipfile
from collections.abc import Callable
from pathlib import Path, PurePosixPath

import pytest

sys.path.insert(0, str(Path("tools").resolve()))

from vendor_sqlparse import (  # ty: ignore[unresolved-import]
    DIST_INFO,
    EXPECTED_DIST_FILES,
    EXPECTED_PACKAGE_FILES,
    VendorError,
    _remove_path,
    _replace_vendor_tree,
    checked_destination,
    fixed_provenance_root,
    fixed_vendor_root,
    validate_archive,
    validate_lock_projection,
    validated_members,
    verify_tree_hashes,
)
from verify_vendor import verify  # ty: ignore[unresolved-import]

ROOT = Path(__file__).resolve().parents[2]


def write_synthetic_wheel(root: Path, members: dict[str, bytes]) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    wheel = root / "synthetic.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        for name, payload in members.items():
            archive.writestr(name, payload)
    return wheel


def valid_members() -> dict[str, bytes]:
    members = {
        "sqlparse/__init__.py": b'__version__ = "0.5.5"\n',
        "sqlparse-0.5.5.dist-info/METADATA": (
            b"Metadata-Version: 2.1\nName: sqlparse\nVersion: 0.5.5\n"
            b"License: BSD-3-Clause\n"
        ),
        "sqlparse-0.5.5.dist-info/licenses/LICENSE": b"BSD\n",
        "sqlparse-0.5.5.dist-info/licenses/AUTHORS": b"Authors\n",
    }
    for relative in EXPECTED_PACKAGE_FILES:
        members.setdefault(f"sqlparse/{relative}", b"\n")
    for relative in EXPECTED_DIST_FILES:
        members.setdefault(f"{DIST_INFO}/{relative}", b"\n")
    return members


@pytest.mark.parametrize("member", ["sqlparse", DIST_INFO])
def test_vendor_rejects_archive_root_members(tmp_path: Path, member: str) -> None:
    wheel = write_synthetic_wheel(
        tmp_path,
        {
            **valid_members(),
            member: b"root\n",
        },
    )
    with pytest.raises(VendorError):
        with zipfile.ZipFile(wheel) as archive:
            validated_members(archive)


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


def test_nested_symlink_is_rejected_before_directory_traversal(tmp_path: Path) -> None:
    vendor = tmp_path / "sqlparse"
    outside = tmp_path / "outside"
    vendor.mkdir()
    outside.mkdir()
    (outside / "secret.py").write_bytes(b"secret")
    try:
        (vendor / "nested").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks unavailable")
    with pytest.raises(VendorError):
        verify_tree_hashes(vendor, {})


def test_fixed_vendor_root_rejects_symlink_escape(tmp_path: Path) -> None:
    (tmp_path / "python").mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    try:
        (tmp_path / "python" / "vendor").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks unavailable")
    with pytest.raises(VendorError):
        fixed_vendor_root(tmp_path)


def test_fixed_provenance_root_rejects_symlink_escape(tmp_path: Path) -> None:
    (tmp_path / "third_party").mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    try:
        (tmp_path / "third_party" / "sqlparse").symlink_to(
            outside, target_is_directory=True
        )
    except OSError:
        pytest.skip("symlinks unavailable")
    with pytest.raises(VendorError):
        fixed_provenance_root(tmp_path)


def test_fixed_provenance_parent_rejects_symlink_escape(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    try:
        (tmp_path / "third_party").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks unavailable")
    with pytest.raises(VendorError):
        fixed_provenance_root(tmp_path)


def test_vendor_tree_replacement_retains_backup_for_rollback(tmp_path: Path) -> None:
    target = tmp_path / "sqlparse"
    staged = tmp_path / "staged"
    target.mkdir()
    staged.mkdir()
    (target / "old.py").write_bytes(b"old")
    (staged / "new.py").write_bytes(b"new")
    backup = _replace_vendor_tree(staged, target)
    assert backup is not None
    assert backup.exists()
    _remove_path(target)
    backup.rename(target)
    assert (target / "old.py").read_bytes() == b"old"


@pytest.mark.parametrize("member", ["sqlparse/__init__.py", f"{DIST_INFO}/METADATA"])
def test_malformed_wheel_text_is_rejected_as_vendor_error(
    tmp_path: Path, member: str
) -> None:
    members = valid_members()
    members[member] = b"\xff"
    wheel = write_synthetic_wheel(tmp_path, members)
    with zipfile.ZipFile(wheel) as archive:
        with pytest.raises(VendorError):
            validate_archive(archive)


@pytest.mark.parametrize(
    ("field", "value"),
    [("Name", "other"), ("License", "MIT")],
)
def test_metadata_identity_and_license_are_strict(
    tmp_path: Path, field: str, value: str
) -> None:
    members = valid_members()
    metadata = members[f"{DIST_INFO}/METADATA"].decode()
    if field == "Name":
        metadata = metadata.replace("Name: sqlparse", f"Name: {value}")
    else:
        metadata = metadata.replace("License: BSD-3-Clause", f"License: {value}")
    members[f"{DIST_INFO}/METADATA"] = metadata.encode()
    wheel = write_synthetic_wheel(tmp_path, members)
    with zipfile.ZipFile(wheel) as archive:
        with pytest.raises(VendorError):
            validate_archive(archive)


def test_metadata_license_header_is_required(tmp_path: Path) -> None:
    members = valid_members()
    metadata = members[f"{DIST_INFO}/METADATA"].decode()
    members[f"{DIST_INFO}/METADATA"] = metadata.replace(
        "License: BSD-3-Clause\n", ""
    ).encode()
    wheel = write_synthetic_wheel(tmp_path, members)
    with zipfile.ZipFile(wheel) as archive:
        with pytest.raises(VendorError):
            validate_archive(archive)


def test_metadata_mit_license_contradicts_official_license_files(
    tmp_path: Path,
) -> None:
    members = valid_members()
    metadata = members[f"{DIST_INFO}/METADATA"].decode()
    metadata = metadata.replace(
        "License: BSD-3-Clause",
        "License: MIT\nLicense-File: AUTHORS\nLicense-File: LICENSE",
    )
    members[f"{DIST_INFO}/METADATA"] = metadata.encode()
    wheel = write_synthetic_wheel(tmp_path, members)
    with zipfile.ZipFile(wheel) as archive:
        with pytest.raises(VendorError):
            validate_archive(archive)


def test_lock_and_requirements_projection_must_agree(tmp_path: Path) -> None:
    lock = tmp_path / "sqlparse-vendor.lock"
    requirements = tmp_path / "sqlparse-vendor.requirements.txt"
    lock.write_text("name=sqlparse\nversion=0.5.5\n", encoding="utf-8")
    requirements.write_text("sqlparse==0.4.0\n", encoding="utf-8")
    with pytest.raises(VendorError):
        validate_lock_projection(lock, requirements)


def make_verification_root(tmp_path: Path) -> Path:
    root = tmp_path / "extension"
    for relative in (
        "tools/sqlparse-vendor.lock",
        "tools/sqlparse-vendor.requirements.txt",
        "third_party/sqlparse/SOURCE.json",
        "third_party/sqlparse/LICENSE",
        "third_party/sqlparse/AUTHORS",
        "third_party/sqlparse/files.sha256",
    ):
        source = ROOT / relative
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    shutil.copytree(ROOT / "python/vendor/sqlparse", root / "python/vendor/sqlparse")
    return root


@pytest.mark.parametrize("notice", ["LICENSE", "AUTHORS"])
def test_verify_vendor_rejects_mutated_notice(tmp_path: Path, notice: str) -> None:
    root = make_verification_root(tmp_path)
    path = root / "third_party/sqlparse" / notice
    path.write_bytes(path.read_bytes() + b"tampered")
    with pytest.raises(VendorError):
        verify(root)


@pytest.mark.parametrize("field", ["licenseSha256", "authorsSha256", "generatedAt"])
def test_verify_vendor_rejects_mutated_source_provenance(
    tmp_path: Path, field: str
) -> None:
    root = make_verification_root(tmp_path)
    path = root / "third_party/sqlparse/SOURCE.json"
    source = json.loads(path.read_text(encoding="utf-8"))
    source[field] = "tampered"
    path.write_text(json.dumps(source), encoding="utf-8")
    with pytest.raises(VendorError):
        verify(root)


def test_verify_vendor_rejects_extra_source_provenance_key(tmp_path: Path) -> None:
    root = make_verification_root(tmp_path)
    path = root / "third_party/sqlparse/SOURCE.json"
    source = json.loads(path.read_text(encoding="utf-8"))
    source["unexpected"] = "extra"
    path.write_text(json.dumps(source), encoding="utf-8")
    with pytest.raises(VendorError):
        verify(root)


@pytest.mark.parametrize("artifact", ["LICENSE", "AUTHORS", "files.sha256"])
def test_verify_vendor_rejects_symlinked_provenance_artifact(
    tmp_path: Path, artifact: str
) -> None:
    root = make_verification_root(tmp_path)
    path = root / "third_party/sqlparse" / artifact
    target = tmp_path / f"{artifact}.outside"
    target.write_bytes(path.read_bytes())
    path.unlink()
    try:
        path.symlink_to(target)
    except OSError:
        pytest.skip("symlinks unavailable")
    with pytest.raises(VendorError):
        verify(root)


def test_checked_destination_uses_posix_components(tmp_path: Path) -> None:
    staging = tmp_path / "staging"
    staging.mkdir()
    destination = checked_destination(staging, "sqlparse/submodule.py")
    assert destination == (staging / PurePosixPath("sqlparse/submodule.py")).resolve()
