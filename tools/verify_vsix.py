"""Validate the reproducible, offline VSIX inventory without extracting it."""

from __future__ import annotations

import argparse
import io
import json
import re
import stat
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

MAX_VSIX_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 128 * 1024 * 1024
MAX_MEMBER_BYTES = 32 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200

REQUIRED_PACKAGE_MEMBERS = frozenset(
    {
        "[Content_Types].xml",
        "extension.vsixmanifest",
        "extension/package.json",
        "extension/package.nls.json",
        "extension/package.nls.ja.json",
        "extension/readme.md",
        "extension/changelog.md",
        "extension/LICENSE.txt",
        "extension/SECURITY.md",
        "extension/SUPPORT.md",
        "extension/THIRD_PARTY_NOTICES.md",
        "extension/dist/extension.js",
        "extension/dist/package.json",
        "extension/icon.png",
    }
)

EXACT_FIRST_PARTY_MEMBERS = frozenset(
    {
        "extension/syntaxes/inline-sql-fstring-islands.tmLanguage.json",
        "extension/syntaxes/inline-sql-python.tmLanguage.json",
    }
)


class VsixError(ValueError):
    """A source-free archive validation failure."""


@dataclass(frozen=True, slots=True)
class ValidatedVsix:
    archive_bytes: bytes
    members: tuple[str, ...]
    expanded_bytes: int


def safe_member_name(info: zipfile.ZipInfo) -> str:
    name = info.filename
    path = PurePosixPath(name)
    mode = info.external_attr >> 16
    if (
        "\x00" in name
        or "\\" in name
        or path.is_absolute()
        or ".." in path.parts
        or stat.S_ISLNK(mode)
    ):
        raise VsixError("unsafe archive member")
    normalized = path.as_posix()
    if not normalized or normalized == ".":
        raise VsixError("unsafe archive member")
    return normalized


def read_bounded_vsix(path: Path) -> bytes:
    try:
        with path.open("rb") as stream:
            payload = stream.read(MAX_VSIX_BYTES + 1)
    except OSError as exc:
        raise VsixError("cannot read VSIX") from exc
    if len(payload) > MAX_VSIX_BYTES:
        raise VsixError("VSIX compressed size limit exceeded")
    return payload


def read_bounded_member(archive: zipfile.ZipFile, name: str) -> bytes:
    try:
        info = archive.getinfo(name)
    except KeyError:
        raise VsixError("required archive member is missing") from None
    if info.file_size > MAX_MEMBER_BYTES:
        raise VsixError("VSIX member size limit exceeded")
    try:
        with archive.open(info) as stream:
            payload = stream.read(info.file_size + 1)
    except (OSError, RuntimeError, zipfile.BadZipFile, zipfile.LargeZipFile) as exc:
        raise VsixError("invalid archive member") from exc
    if len(payload) != info.file_size:
        raise VsixError("VSIX member size mismatch")
    return payload


def posix_ancestors(member: str) -> tuple[str, ...]:
    parts = PurePosixPath(member).parts
    return tuple("/".join(parts[:index]) + "/" for index in range(1, len(parts)))


def validate_packaged_manifest(manifest: object) -> None:
    if not isinstance(manifest, dict):
        raise VsixError("invalid extension manifest")
    if manifest.get("name") != "inline-sql-toolkit":
        raise VsixError("invalid extension manifest")
    if manifest.get("publisher") != "hidenobunagai":
        raise VsixError("invalid extension manifest")
    if manifest.get("version") != "0.1.1":
        raise VsixError("invalid extension manifest")
    if manifest.get("main") != "./dist/extension.js":
        raise VsixError("invalid extension manifest")
    engines = manifest.get("engines")
    if not isinstance(engines, dict) or engines != {"vscode": "^1.95.0"}:
        raise VsixError("invalid extension manifest")
    if "node_modules" in manifest:
        raise VsixError("unexpected dependency tree")


_FORBIDDEN_COMPONENTS = {
    "node_modules",
    "__pycache__",
    "tests",
    "test",
    "spec",
    "specs",
    "plans",
    "reports",
    "coverage",
}
_FORBIDDEN_SUFFIXES = (".ts", ".map", ".lock", ".pyc")
_ABSOLUTE_PATH = re.compile(
    rb"(?:\b[A-Za-z]:[\\/][A-Za-z0-9._-]{2,}(?:[\\/][A-Za-z0-9._-]{2,})*|"
    rb"\\\\[A-Za-z0-9._-]{2,}[\\/][A-Za-z0-9._-]{2,}(?:[\\/][A-Za-z0-9._-]{2,})*|"
    rb"(?<![A-Za-z0-9_/:.!-])/(?!/)(?:[A-Za-z0-9._-]{2,}/)+[A-Za-z0-9._-]{2,}|"
    rb"(?<![A-Za-z0-9_/:.!-])/(?:tmp|etc|root|home|Users|private|var|opt|srv|workspace)"
    rb"(?=$|[\s\"'<>),;]))"
)
_SECRET_LIKE = re.compile(
    rb"(?:sk_live_[a-z0-9]{20,}|sk_test_[a-z0-9]{20,}|sk_[a-z0-9]{24,}|"
    rb"(?i:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|"
    rb"xox[baprs]-[A-Za-z0-9-]{20,}|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----)|"
    rb"(?i:aws[_-]?(?:access[_-]?key|secret[_-]?access[_-]?key|session[_-]?token)|"
    rb"password|passwd|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*[\"']?"
    rb"[A-Za-z0-9_./+=-]{12,}[\"']?)"
)


def scan_for_forbidden_runtime_content(
    archive: zipfile.ZipFile, file_names: set[str]
) -> None:
    for name in file_names:
        parts = PurePosixPath(name).parts
        if any(part in _FORBIDDEN_COMPONENTS for part in parts):
            raise VsixError("forbidden runtime member")
        if name.endswith(_FORBIDDEN_SUFFIXES):
            raise VsixError("forbidden runtime member")
        payload = read_bounded_member(archive, name)
        if _ABSOLUTE_PATH.search(payload) or _SECRET_LIKE.search(payload):
            raise VsixError("forbidden runtime content")


def _validate_archive_bytes(archive_bytes: bytes) -> ValidatedVsix:
    try:
        archive = zipfile.ZipFile(io.BytesIO(archive_bytes))
    except (OSError, zipfile.BadZipFile) as exc:
        raise VsixError("invalid VSIX archive") from exc
    with archive:
        infos = tuple(archive.infolist())
        names = [safe_member_name(info) for info in infos]
        if len(names) != len(set(names)):
            raise VsixError("duplicate archive member")
        expanded_bytes = 0
        for info in infos:
            if info.is_dir():
                continue
            if info.file_size > MAX_MEMBER_BYTES:
                raise VsixError("VSIX member size limit exceeded")
            if info.file_size > 0 and info.compress_size == 0:
                raise VsixError("VSIX compression ratio limit exceeded")
            if (
                info.compress_size > 0
                and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO
            ):
                raise VsixError("VSIX compression ratio limit exceeded")
            expanded_bytes += info.file_size
            if expanded_bytes > MAX_EXPANDED_BYTES:
                raise VsixError("VSIX expanded size limit exceeded")

        expected = REQUIRED_PACKAGE_MEMBERS | EXACT_FIRST_PARTY_MEMBERS
        file_names = {
            name for name, info in zip(names, infos, strict=True) if not info.is_dir()
        }
        directory_names = set(names) - file_names
        allowed_directories = {
            ancestor for member in expected for ancestor in posix_ancestors(member)
        }
        if file_names != expected or not directory_names <= allowed_directories:
            raise VsixError("archive inventory mismatch")

        try:
            manifest = json.loads(
                read_bounded_member(archive, "extension/package.json").decode("utf-8")
            )
            validate_packaged_manifest(manifest)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise VsixError("invalid extension manifest") from exc

        scan_for_forbidden_runtime_content(archive, file_names)
        return ValidatedVsix(
            archive_bytes=archive_bytes,
            members=tuple(sorted(file_names)),
            expanded_bytes=expanded_bytes,
        )


def validate_vsix(path: Path) -> ValidatedVsix:
    return _validate_archive_bytes(read_bounded_vsix(path))


def component_report(validated: ValidatedVsix) -> dict[str, object]:
    return {
        "results": [
            {
                "packages": [
                    {
                        "package": {
                            "name": "sql-formatter",
                            "version": "15.8.2",
                            "ecosystem": "npm",
                        }
                    }
                ]
            }
        ]
    }


def write_component_report(validated: ValidatedVsix, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(component_report(validated), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vsix", type=Path)
    parser.add_argument(
        "--report", type=Path, default=Path("reports/vsix-components.osv.json")
    )
    args = parser.parse_args(argv)
    try:
        validated = validate_vsix(args.vsix)
        write_component_report(validated, args.report)
    except (VsixError, OSError, ValueError):
        sys.stderr.write("VSIX verification failed\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
