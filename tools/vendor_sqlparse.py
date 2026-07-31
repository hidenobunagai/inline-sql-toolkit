"""Download, validate, and install the pinned sqlparse wheel."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path, PurePosixPath


class VendorError(ValueError):
    """A source-free vendor archive or provenance violation."""


REQUIRED_VERSION = "0.5.5"
REQUIRED_LICENSE = "BSD-3-Clause"
REQUIRED_WHEEL = "sqlparse-0.5.5-py3-none-any.whl"
REQUIRED_URL = (
    "https://files.pythonhosted.org/packages/49/4b/359f28a903c13438ef59ebeee215fb25da53066db67b305c125f1c6d2a25/"
    "sqlparse-0.5.5-py3-none-any.whl"
)
REQUIRED_SHA256 = "12a08b3bf3eec877c519589833aed092e2444e68240a3577e8e26148acc7b1ba"
REQUIRED_LICENSE_SHA256 = (
    "c1938235b80d39e93138eae89edc3af67e18ecbc40d266529fa57b2dce426310"
)
REQUIRED_AUTHORS_SHA256 = (
    "65ed421fc032252eb23b7a4b64ed6915c12c3bf64dec6f3dd4d7b5b421f8fd3c"
)
DIST_INFO = "sqlparse-0.5.5.dist-info"
EXPECTED_PACKAGE_FILES = frozenset(
    {
        "__init__.py",
        "__main__.py",
        "cli.py",
        "exceptions.py",
        "formatter.py",
        "keywords.py",
        "lexer.py",
        "py.typed",
        "sql.py",
        "tokens.py",
        "utils.py",
        "engine/__init__.py",
        "engine/filter_stack.py",
        "engine/grouping.py",
        "engine/statement_splitter.py",
        "filters/__init__.py",
        "filters/aligned_indent.py",
        "filters/others.py",
        "filters/output.py",
        "filters/reindent.py",
        "filters/right_margin.py",
        "filters/tokens.py",
    }
)
EXPECTED_DIST_FILES = frozenset(
    {
        "METADATA",
        "WHEEL",
        "entry_points.txt",
        "RECORD",
        "licenses/AUTHORS",
        "licenses/LICENSE",
    }
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_lock(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            key, separator, value = line.partition("=")
            if not separator or not key or not value or key in values:
                raise VendorError("invalid vendor lock")
            values[key] = value
    except (OSError, UnicodeError) as exc:
        raise VendorError("cannot read vendor lock") from exc
    required = {"name", "version", "wheel", "url", "sha256", "license"}
    if set(values) != required or values.get("name") != "sqlparse":
        raise VendorError("invalid vendor lock")
    if (
        values["version"] != REQUIRED_VERSION
        or values["wheel"] != REQUIRED_WHEEL
        or values["url"] != REQUIRED_URL
        or values["sha256"] != REQUIRED_SHA256
        or values["license"] != REQUIRED_LICENSE
    ):
        raise VendorError("invalid vendor lock")
    if len(values["sha256"]) != 64 or not re.fullmatch(
        r"[0-9a-f]{64}", values["sha256"]
    ):
        raise VendorError("invalid vendor lock")
    return values


def validated_members(archive: zipfile.ZipFile) -> tuple[zipfile.ZipInfo, ...]:
    members = tuple(archive.infolist())
    names = [member.filename for member in members]
    if len(names) != len(set(names)):
        raise VendorError("duplicate wheel member")
    for member in members:
        if "\\" in member.filename:
            raise VendorError("unsafe wheel member")
        path = PurePosixPath(member.filename)
        mode = member.external_attr >> 16
        if path.is_absolute() or ".." in path.parts or stat.S_ISLNK(mode):
            raise VendorError("unsafe wheel member")
        if member.filename in {"sqlparse", DIST_INFO}:
            raise VendorError("unsafe wheel member")
        if not path.parts or path.parts[0] not in {"sqlparse", DIST_INFO}:
            raise VendorError("unexpected wheel member")
    return members


def checked_destination(staging_root: Path, member_name: str) -> Path:
    if "\\" in member_name:
        raise VendorError("unsafe wheel member")
    path = PurePosixPath(member_name)
    destination = (staging_root / path).resolve()
    try:
        destination.relative_to(staging_root.resolve())
    except ValueError as exc:
        raise VendorError("wheel member escapes staging") from exc
    return destination


def _member_bytes(archive: zipfile.ZipFile, name: str) -> bytes:
    try:
        return archive.read(name)
    except (KeyError, OSError, RuntimeError, zipfile.BadZipFile) as exc:
        raise VendorError("invalid wheel member") from exc


def validate_archive(
    archive_or_path: zipfile.ZipFile | Path,
    *,
    expected_sha256: str | None = None,
) -> tuple[zipfile.ZipInfo, ...]:
    if isinstance(archive_or_path, Path):
        if (
            expected_sha256 is not None
            and sha256_file(archive_or_path) != expected_sha256
        ):
            raise VendorError("wheel hash mismatch")
        try:
            with zipfile.ZipFile(archive_or_path) as archive:
                return _validate_open_archive(archive)
        except (OSError, zipfile.BadZipFile) as exc:
            raise VendorError("invalid wheel archive") from exc
    return _validate_open_archive(archive_or_path)


def _validate_open_archive(archive: zipfile.ZipFile) -> tuple[zipfile.ZipInfo, ...]:
    members = validated_members(archive)
    names = {member.filename for member in members}
    package_names = {
        name.removeprefix("sqlparse/") for name in names if name.startswith("sqlparse/")
    }
    dist_names = {
        name.removeprefix(f"{DIST_INFO}/")
        for name in names
        if name.startswith(f"{DIST_INFO}/")
    }
    if package_names != EXPECTED_PACKAGE_FILES or dist_names != EXPECTED_DIST_FILES:
        raise VendorError("unexpected or missing wheel member")
    try:
        init = _member_bytes(archive, "sqlparse/__init__.py").decode("utf-8")
        metadata = _member_bytes(archive, f"{DIST_INFO}/METADATA").decode("utf-8")
    except UnicodeDecodeError as exc:
        raise VendorError("invalid wheel text") from exc
    init_version = re.search(r"__version__\s*=\s*['\"]([^'\"]+)", init)
    metadata_name = re.search(r"^Name:\s*(\S+)\s*$", metadata, re.MULTILINE)
    metadata_version = re.search(r"^Version:\s*(\S+)\s*$", metadata, re.MULTILINE)
    metadata_license = re.search(
        r"^License(?:-Expression)?:\s*(\S+)\s*$", metadata, re.MULTILINE
    )
    license_files = set(
        re.findall(r"^License-File:\s*(\S+)\s*$", metadata, re.MULTILINE)
    )
    license_is_exact = (
        metadata_license is not None and metadata_license.group(1) == REQUIRED_LICENSE
    ) or license_files == {"AUTHORS", "LICENSE"}
    if not init_version or init_version.group(1) != REQUIRED_VERSION:
        raise VendorError("wrong sqlparse version")
    if (
        not metadata_name
        or metadata_name.group(1) != "sqlparse"
        or not metadata_version
        or metadata_version.group(1) != REQUIRED_VERSION
        or not license_is_exact
    ):
        raise VendorError("wrong wheel version")
    return members


def _inventory(vendor_root: Path) -> dict[str, str]:
    if not vendor_root.is_dir() or vendor_root.is_symlink():
        raise VendorError("invalid vendor tree")
    result: dict[str, str] = {}
    for path in sorted(vendor_root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            if path.is_symlink():
                raise VendorError("invalid vendor tree")
            if path.is_dir():
                continue
            raise VendorError("invalid vendor tree")
        result[path.relative_to(vendor_root).as_posix()] = sha256_file(path)
    return result


def verify_tree_hashes(vendor_root: Path, expected: dict[str, str]) -> None:
    actual = _inventory(vendor_root)
    if actual != dict(sorted(expected.items())):
        raise VendorError("vendored file hash mismatch")


def parse_inventory(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise VendorError("cannot read vendor inventory") from exc
    inventory: dict[str, str] = {}
    for line in lines:
        if not line.strip():
            continue
        digest, separator, relative = line.partition("  ")
        if not separator or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise VendorError("invalid vendor inventory")
        if not relative or relative in inventory or "\\" in relative:
            raise VendorError("invalid vendor inventory")
        inventory[relative] = digest
    return dict(sorted(inventory.items()))


def validate_lock_projection(lock_path: Path, requirements_path: Path) -> None:
    lock = read_lock(lock_path)
    try:
        lines = [
            line.strip()
            for line in requirements_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    except (OSError, UnicodeError) as exc:
        raise VendorError("cannot read requirements projection") from exc
    if lines != [f"sqlparse=={lock['version']}"]:
        raise VendorError("requirements projection disagrees with vendor lock")


def fixed_vendor_root(root: Path) -> Path:
    expected = root / "python" / "vendor"
    if expected.parent.is_symlink() or expected.is_symlink():
        raise VendorError("symlinked vendor root")
    resolved = expected.resolve()
    if resolved != expected:
        raise VendorError("vendor root escapes extension root")
    return resolved


def _extract_to_staging(
    archive_path: Path,
    staging_root: Path,
    members: tuple[zipfile.ZipInfo, ...],
) -> None:
    with zipfile.ZipFile(archive_path) as archive:
        for member in members:
            if not member.filename.startswith("sqlparse/") or member.is_dir():
                continue
            relative_name = member.filename.removeprefix("sqlparse/")
            destination = checked_destination(staging_root, relative_name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(archive.read(member))
            os.chmod(destination, 0o644)


def _remove_path(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink()


def _replace_vendor_tree(staged: Path, target: Path) -> Path | None:
    parent = target.parent.resolve()
    parent.mkdir(parents=True, exist_ok=True)
    backup: Path | None = None
    if target.exists() or target.is_symlink():
        backup = parent / f".{target.name}.backup-{uuid.uuid4().hex}"
        target.rename(backup)
    try:
        staged.rename(target)
    except BaseException:
        if backup is not None and not target.exists():
            backup.rename(target)
        raise
    return backup


def vendor(lock_path: Path) -> None:
    lock = read_lock(lock_path)
    root = Path(__file__).resolve().parents[1]
    vendor_parent = fixed_vendor_root(root)
    target = vendor_parent / "sqlparse"
    vendor_parent.mkdir(parents=True, exist_ok=True)
    license_bytes: bytes
    authors_bytes: bytes
    backup: Path | None = None
    installed_new_tree = False
    with tempfile.TemporaryDirectory(
        prefix="sqlparse-download-", dir=vendor_parent
    ) as temp:
        temp_root = Path(temp)
        wheel_path = temp_root / lock["wheel"]
        try:
            with (
                urllib.request.urlopen(lock["url"], timeout=60) as response,
                wheel_path.open("wb") as output,
            ):
                shutil.copyfileobj(response, output)
        except (OSError, TimeoutError, urllib.error.URLError) as exc:
            raise VendorError("wheel download failed") from exc
        if sha256_file(wheel_path) != lock["sha256"]:
            raise VendorError("wheel hash mismatch")
        members = validate_archive(wheel_path, expected_sha256=lock["sha256"])
        with zipfile.ZipFile(wheel_path) as archive:
            license_bytes = archive.read(f"{DIST_INFO}/licenses/LICENSE")
            authors_bytes = archive.read(f"{DIST_INFO}/licenses/AUTHORS")
        staged = vendor_parent / f".sqlparse-staged-{uuid.uuid4().hex}"
        staged.mkdir()
        try:
            _extract_to_staging(wheel_path, staged, members)
            if (
                target.is_dir()
                and not target.is_symlink()
                and _inventory(target) == _inventory(staged)
            ):
                shutil.rmtree(staged)
            else:
                backup = _replace_vendor_tree(staged, target)
                installed_new_tree = True
        finally:
            if staged.exists():
                shutil.rmtree(staged)
    third_party = root / "third_party" / "sqlparse"
    artifact_paths = {
        name: third_party / name
        for name in ("LICENSE", "AUTHORS", "files.sha256", "SOURCE.json")
    }
    old_artifacts: dict[Path, bytes | None] = {}
    third_party_created = not third_party.exists()
    try:
        if third_party.is_symlink():
            raise VendorError("symlinked provenance root")
        third_party.mkdir(parents=True, exist_ok=True)
        for path in artifact_paths.values():
            if path.is_symlink():
                raise VendorError("symlinked provenance file")
            old_artifacts[path] = path.read_bytes() if path.exists() else None
        artifact_paths["LICENSE"].write_bytes(license_bytes)
        artifact_paths["AUTHORS"].write_bytes(authors_bytes)
        inventory = _inventory(target)
        artifact_paths["files.sha256"].write_text(
            "".join(
                f"{digest}  {relative}\n" for relative, digest in inventory.items()
            ),
            encoding="utf-8",
        )
        artifact_paths["SOURCE.json"].write_text(
            json.dumps(
                {
                    "name": lock["name"],
                    "version": lock["version"],
                    "url": lock["url"],
                    "wheel": lock["wheel"],
                    "sha256": lock["sha256"],
                    "license": lock["license"],
                    "licenseSha256": REQUIRED_LICENSE_SHA256,
                    "authorsSha256": REQUIRED_AUTHORS_SHA256,
                    "generatedAt": "omitted for deterministic output",
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
    except BaseException:
        for path, previous in old_artifacts.items():
            if previous is None:
                if path.exists() or path.is_symlink():
                    _remove_path(path)
            else:
                path.write_bytes(previous)
        if (
            third_party_created
            and third_party.exists()
            and not any(third_party.iterdir())
        ):
            third_party.rmdir()
        if installed_new_tree:
            if target.exists() or target.is_symlink():
                _remove_path(target)
            if backup is not None:
                backup.rename(target)
            backup = None
        raise
    if backup is not None:
        _remove_path(backup)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--lock", required=True)
    args = parser.parse_args(argv)
    try:
        vendor(Path(args.lock).resolve())
    except BaseException as exc:
        sys.stderr.write(f"vendor error: {exc}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
