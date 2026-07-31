from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path("tools").resolve()))

from offline_vsix_smoke import (  # noqa: E402
    OfflineSmokeError,
    extract_validated_vsix,
    run_offline_smoke,
)
from verify_vsix import (  # noqa: E402
    MAX_COMPRESSION_RATIO,
    MAX_MEMBER_BYTES,
    MAX_VSIX_BYTES,
    ValidatedVsix,
    VsixError,
    parse_vendor_inventory,
    validate_vsix,
)

ROOT = Path(__file__).resolve().parents[2]


def _vendor_files() -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    for line in (ROOT / "third_party/sqlparse/files.sha256").read_text().splitlines():
        digest, relative = line.split()
        del digest
        result[f"extension/python/vendor/sqlparse/{relative}"] = (
            ROOT / "python/vendor/sqlparse" / relative
        ).read_bytes()
    return result


def valid_members() -> dict[str, bytes]:
    members = {
        "[Content_Types].xml": (
            b"<Types xmlns='http://schemas.openxmlformats.org/"
            b"package/2006/content-types' />"
        ),
        "extension.vsixmanifest": b"<PackageManifest />",
        "extension/package.json": json.dumps(
            {
                "name": "inline-sql-toolkit",
                "publisher": "hidenobunagai",
                "version": "0.1.0",
                "main": "./dist/extension.js",
                "engines": {"vscode": "^1.95.0"},
            }
        ).encode(),
        "extension/package.nls.json": b"{}",
        "extension/package.nls.ja.json": b"{}",
        "extension/readme.md": b"README",
        "extension/changelog.md": b"CHANGELOG",
        "extension/LICENSE.txt": b"MIT License",
        "extension/SECURITY.md": b"Security",
        "extension/SUPPORT.md": b"Support",
        "extension/THIRD_PARTY_NOTICES.md": b"Notices",
        "extension/dist/extension.js": b"module.exports = {};",
        "extension/python/bootstrap.py": b"print('ok')",
        "extension/syntaxes/inline-sql-fstring-islands.tmLanguage.json": b"{}",
        "extension/syntaxes/inline-sql-python.tmLanguage.json": b"{}",
        "extension/third_party/runtime-components.json": (
            ROOT / "third_party/runtime-components.json"
        ).read_bytes(),
        "extension/third_party/sqlparse/AUTHORS": (
            ROOT / "third_party/sqlparse/AUTHORS"
        ).read_bytes(),
        "extension/third_party/sqlparse/LICENSE": (
            ROOT / "third_party/sqlparse/LICENSE"
        ).read_bytes(),
        "extension/third_party/sqlparse/SOURCE.json": (
            ROOT / "third_party/sqlparse/SOURCE.json"
        ).read_bytes(),
        "extension/third_party/vscode-python-extension/LICENSE.md": (
            ROOT / "third_party/vscode-python-extension/LICENSE.md"
        ).read_bytes(),
        "extension/third_party/vscode-python-extension/SOURCE.json": (
            ROOT / "third_party/vscode-python-extension/SOURCE.json"
        ).read_bytes(),
    }
    for path in (
        "__init__.py",
        "candidate_formatter.py",
        "cli.py",
        "detection.py",
        "engine.py",
        "literals.py",
        "model.py",
        "positions.py",
        "protection.py",
        "protocol.py",
        "sqlparse_adapter.py",
        "token_bundles.py",
    ):
        members[f"extension/python/inline_sql_helper/{path}"] = b"# runtime"
    vendor = _vendor_files()
    inventory = (
        "\n".join(
            f"{__import__('hashlib').sha256(payload).hexdigest()} "
            f"{path.removeprefix('extension/python/vendor/sqlparse/')}"
            for path, payload in sorted(vendor.items())
        )
        + "\n"
    )
    members["extension/third_party/sqlparse/files.sha256"] = inventory.encode()
    members.update(vendor)
    return members


def write_archive(
    path: Path, members: dict[str, bytes], *, duplicate: bool = False
) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in members.items():
            archive.writestr(name, payload)
        if duplicate:
            archive.writestr(next(iter(members)), b"duplicate")


def make_valid(tmp_path: Path) -> Path:
    path = tmp_path / "valid.vsix"
    write_archive(path, valid_members())
    return path


def test_valid_archive_and_component_report(tmp_path: Path) -> None:
    validated = validate_vsix(make_valid(tmp_path))
    assert "extension/python/bootstrap.py" in validated.members
    assert validated.vendor_hashes


@pytest.mark.parametrize(
    "extra",
    [
        "extension/python/inline_sql_helper/extra.py",
        "extension/syntaxes/extra.json",
        "extension/third_party/extra.bin",
        "extension/python/vendor/sqlparse/extra.py",
        "extension/extra.ts",
        "extension/dist/extension.js.map",
        "extension/package-lock.json",
        "extension/test/test.py",
        "extension/docs/specs/design.md",
        "extension/python/inline_sql_helper/__pycache__/x.pyc",
    ],
)
def test_rejects_unexpected_runtime_members(tmp_path: Path, extra: str) -> None:
    members = valid_members()
    members[extra] = b"x"
    path = tmp_path / "bad.vsix"
    write_archive(path, members)
    with pytest.raises(VsixError):
        validate_vsix(path)


def test_rejects_duplicates_and_unsafe_names(tmp_path: Path) -> None:
    path = tmp_path / "duplicate.vsix"
    write_archive(path, valid_members(), duplicate=True)
    with pytest.raises(VsixError):
        validate_vsix(path)
    members = valid_members()
    members["../escape"] = b"x"
    write_archive(path, members)
    with pytest.raises(VsixError):
        validate_vsix(path)


def test_rejects_symlink_member(tmp_path: Path) -> None:
    path = tmp_path / "symlink.vsix"
    members = valid_members()
    with zipfile.ZipFile(path, "w") as archive:
        for name, payload in members.items():
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            if name == "extension/python/bootstrap.py":
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, payload)
    with pytest.raises(VsixError):
        validate_vsix(path)


@pytest.mark.parametrize("field", ["main", "engines", "version"])
def test_rejects_wrong_manifest(tmp_path: Path, field: str) -> None:
    members = valid_members()
    manifest = json.loads(members["extension/package.json"])
    manifest[field] = "wrong" if field != "engines" else {"vscode": "^0.1.0"}
    members["extension/package.json"] = json.dumps(manifest).encode()
    path = tmp_path / "bad.vsix"
    write_archive(path, members)
    with pytest.raises(VsixError):
        validate_vsix(path)


@pytest.mark.parametrize("name", ["absolute", "secret"])
def test_rejects_forbidden_content(tmp_path: Path, name: str) -> None:
    members = valid_members()
    members["extension/dist/extension.js"] = (
        b"const p='/Users/private/source';"
        if name == "absolute"
        else b"token=ghp_12345678901234567890"
    )
    path = tmp_path / "bad.vsix"
    write_archive(path, members)
    with pytest.raises(VsixError):
        validate_vsix(path)


@pytest.mark.parametrize(
    "payload",
    [
        b"/etc/passwd",
        b"/root/key",
        b"/usr/local/bin/tool",
        b"/srv/data/file",
        b"/tmp",
        b"C:\\Users\\secret\\key",
        b"C:\\foo",
        b"\\\\server\\share\\secret",
        b"api_key=abcdefghijklmnop",
        b"AWS_SECRET_ACCESS_KEY=abcdefghijklmnop",
        b"-----BEGIN PRIVATE KEY-----",
    ],
)
def test_rejects_general_paths_and_secret_like_values(
    tmp_path: Path, payload: bytes
) -> None:
    members = valid_members()
    members["extension/dist/extension.js"] = payload
    path = tmp_path / "bad.vsix"
    write_archive(path, members)
    with pytest.raises(VsixError):
        validate_vsix(path)


def test_allows_urls_in_runtime_and_vendor_notices(tmp_path: Path) -> None:
    path = make_valid(tmp_path)
    assert validate_vsix(path).vendor_hashes


def test_rejects_oversized_archive_member_and_total(tmp_path: Path) -> None:
    members = valid_members()
    members["extension/dist/extension.js"] = b"x" * (MAX_MEMBER_BYTES + 1)
    path = tmp_path / "large-member.vsix"
    write_archive(path, members)
    with pytest.raises(VsixError):
        validate_vsix(path)

    members = valid_members()
    chunk = os.urandom(26 * 1024 * 1024)
    for index in range(5):
        members[f"extension/python/inline_sql_helper/large-{index}.py"] = chunk
    write_archive(path, members)
    with pytest.raises(VsixError):
        validate_vsix(path)


def test_rejects_compressed_size_and_archive_limits(tmp_path: Path) -> None:
    path = tmp_path / "compressed.vsix"
    members = valid_members()
    members["extension/dist/extension.js"] = b"x" * (MAX_COMPRESSION_RATIO * 1000)
    write_archive(path, members)
    with pytest.raises(VsixError):
        validate_vsix(path)

    # Corrupt a central-directory uncompressed-size field. The bounded reader
    # must reject the declared/actual mismatch before returning bytes.
    path = make_valid(tmp_path)
    payload = bytearray(path.read_bytes())
    marker = b"extension/readme.md"
    central = payload.find(b"PK\x01\x02" + b"\x14\x00" * 0)
    assert central >= 0
    central = payload.find(marker, central)
    assert central >= 0
    central_header = payload.rfind(b"PK\x01\x02", 0, central)
    assert central_header >= 0
    size_offset = central_header + 24
    payload[size_offset : size_offset + 4] = (999).to_bytes(4, "little")
    path.write_bytes(payload)
    with pytest.raises(VsixError):
        validate_vsix(path)

    path.write_bytes(b"x" * (MAX_VSIX_BYTES + 1))
    with pytest.raises(VsixError):
        validate_vsix(path)


def test_offline_smoke_uses_validated_bytes_and_cleans_up(tmp_path: Path) -> None:
    path = make_valid(tmp_path)
    calls: list[list[str]] = []
    roots: list[Path] = []

    def runner(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        calls.append(args)
        mount = next(
            arg for arg in args if isinstance(arg, str) and arg.startswith("type=bind")
        )
        roots.append(Path(mount.split("src=", 1)[1].split(",", 1)[0]))
        return subprocess.CompletedProcess(
            args, 0, b'{"ok":true,"operation":"format","edits":[{}]}', b""
        )

    run_offline_smoke(path, b"{}", "python:3.12", runner=runner)
    assert calls
    assert calls[0][0:7] == [
        "docker",
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "none",
        "--read-only",
    ]
    assert not roots[0].exists()


def test_offline_smoke_extracts_validated_bytes_after_path_replacement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = make_valid(tmp_path)
    original = path.read_bytes()

    import offline_vsix_smoke

    def validate_then_replace(candidate: Path) -> ValidatedVsix:
        validated = validate_vsix(candidate)
        candidate.write_bytes(b"not-a-vsix")
        return validated

    monkeypatch.setattr(offline_vsix_smoke, "validate_vsix", validate_then_replace)
    result = subprocess.CompletedProcess(
        [], 0, b'{"ok":true,"operation":"format","edits":[{}]}', b""
    )
    run_offline_smoke(path, original, "image", runner=lambda *args, **kwargs: result)


def test_offline_smoke_unsafe_archive_does_not_call_runner(tmp_path: Path) -> None:
    members = valid_members()
    members["extension/extra.bin"] = b"x"
    path = tmp_path / "unsafe.vsix"
    write_archive(path, members)
    calls: list[object] = []
    with pytest.raises(VsixError):
        run_offline_smoke(
            path, b"{}", "image", runner=lambda *args, **kwargs: calls.append(args)
        )
    assert calls == []


def test_offline_smoke_timeout_is_source_free(tmp_path: Path) -> None:
    path = make_valid(tmp_path)
    with pytest.raises(OfflineSmokeError, match="offline smoke timed out"):
        run_offline_smoke(
            path,
            b"{}",
            "image",
            runner=lambda *args, **kwargs: (_ for _ in ()).throw(
                __import__("subprocess").TimeoutExpired("docker", 30)
            ),
        )


def test_extract_rejects_existing_target(tmp_path: Path) -> None:
    validated = validate_vsix(make_valid(tmp_path))
    root = tmp_path / "extract"
    root.mkdir()
    (root / "extension.vsixmanifest").write_bytes(b"already")
    with pytest.raises(VsixError):
        extract_validated_vsix(validated, root)


def test_parse_vendor_inventory_rejects_invalid() -> None:
    with pytest.raises(VsixError):
        parse_vendor_inventory(b"not-a-hash foo.py\n")
    first = "a" * 64
    second = "b" * 64
    with pytest.raises(VsixError):
        parse_vendor_inventory(f"{second} z.py\n{first} a.py\n".encode())


def test_built_bundle_and_provenance_are_present(tmp_path: Path) -> None:
    bundle = ROOT / "dist/extension.js"
    if not bundle.is_file():
        pytest.skip("run bun build before bundle verification")
    text = bundle.read_text(encoding="utf-8")
    assert "@vscode/python-extension" in text
    assert "PythonExtension" in text
    assert (
        (ROOT / "third_party/vscode-python-extension/LICENSE.md")
        .read_text()
        .startswith("Copyright")
    )
    assert (
        json.loads(
            (ROOT / "third_party/vscode-python-extension/SOURCE.json").read_text()
        )["version"]
        == "1.0.5"
    )
    assert (
        json.loads((ROOT / "third_party/sqlparse/SOURCE.json").read_text())["license"]
        == "BSD-3-Clause"
    )
    assert (ROOT / "third_party/sqlparse/AUTHORS").is_file()
    assert (
        json.loads((ROOT / "third_party/sqlparse/SOURCE.json").read_text())["version"]
        == "0.5.5"
    )
