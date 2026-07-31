"""Verify the checked-in sqlparse vendor tree and its provenance records."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from vendor_sqlparse import (
    EXPECTED_SOURCE_KEYS,
    REQUIRED_AUTHORS_SHA256,
    REQUIRED_LICENSE_SHA256,
    VendorError,
    fixed_provenance_root,
    fixed_vendor_root,
    parse_inventory,
    read_lock,
    sha256_file,
    validate_lock_projection,
    verify_tree_hashes,
)


def verify(root: Path) -> None:
    lock_path = root / "tools" / "sqlparse-vendor.lock"
    requirements_path = root / "tools" / "sqlparse-vendor.requirements.txt"
    third_party = fixed_provenance_root(root)
    vendor_root = fixed_vendor_root(root) / "sqlparse"
    lock = read_lock(lock_path)
    validate_lock_projection(lock_path, requirements_path)
    for name in ("LICENSE", "AUTHORS", "files.sha256", "SOURCE.json"):
        path = third_party / name
        if path.is_symlink() or path.is_dir() or not path.is_file():
            raise VendorError("invalid third-party notice")
    if (
        not (third_party / "LICENSE").is_file()
        or not (third_party / "AUTHORS").is_file()
    ):
        raise VendorError("missing third-party notices")
    try:
        source = json.loads((third_party / "SOURCE.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise VendorError("invalid source provenance") from exc
    if not isinstance(source, dict) or set(source) != EXPECTED_SOURCE_KEYS:
        raise VendorError("invalid source provenance")
    for key in (
        "name",
        "version",
        "url",
        "wheel",
        "sha256",
        "license",
        "licenseSha256",
        "authorsSha256",
        "generatedAt",
    ):
        expected = (
            lock.get(key)
            if key in lock
            else {
                "licenseSha256": REQUIRED_LICENSE_SHA256,
                "authorsSha256": REQUIRED_AUTHORS_SHA256,
                "generatedAt": "omitted for deterministic output",
            }[key]
        )
        if source.get(key) != expected:
            raise VendorError("source provenance disagrees with vendor lock")
    if sha256_file(third_party / "LICENSE") != REQUIRED_LICENSE_SHA256:
        raise VendorError("license notice hash mismatch")
    if sha256_file(third_party / "AUTHORS") != REQUIRED_AUTHORS_SHA256:
        raise VendorError("authors notice hash mismatch")
    inventory = parse_inventory(third_party / "files.sha256")
    verify_tree_hashes(vendor_root, inventory)


def verify_lock_projection(root: Path) -> None:
    """Validate only the source-free requirements projection used by OSV."""

    validate_lock_projection(
        root / "tools" / "sqlparse-vendor.lock",
        root / "tools" / "sqlparse-vendor.requirements.txt",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--lock-projection-only", action="store_true")
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    try:
        if args.lock_projection_only:
            verify_lock_projection(root)
        else:
            verify(root)
    except BaseException as exc:
        sys.stderr.write(f"vendor verification failed: {exc}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
