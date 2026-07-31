"""Verify the checked-in sqlparse vendor tree and its provenance records."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from vendor_sqlparse import (
    REQUIRED_AUTHORS_SHA256,
    REQUIRED_LICENSE_SHA256,
    VendorError,
    parse_inventory,
    read_lock,
    sha256_file,
    validate_lock_projection,
    verify_tree_hashes,
)


def verify(root: Path) -> None:
    lock_path = root / "tools" / "sqlparse-vendor.lock"
    requirements_path = root / "tools" / "sqlparse-vendor.requirements.txt"
    third_party = root / "third_party" / "sqlparse"
    lock = read_lock(lock_path)
    validate_lock_projection(lock_path, requirements_path)
    source = json.loads((third_party / "SOURCE.json").read_text(encoding="utf-8"))
    if not isinstance(source, dict):
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
    if (
        not (third_party / "LICENSE").is_file()
        or not (third_party / "AUTHORS").is_file()
    ):
        raise VendorError("missing third-party notices")
    if sha256_file(third_party / "LICENSE") != REQUIRED_LICENSE_SHA256:
        raise VendorError("license notice hash mismatch")
    if sha256_file(third_party / "AUTHORS") != REQUIRED_AUTHORS_SHA256:
        raise VendorError("authors notice hash mismatch")
    inventory = parse_inventory(third_party / "files.sha256")
    verify_tree_hashes(root / "python" / "vendor" / "sqlparse", inventory)


def main() -> int:
    try:
        verify(Path(__file__).resolve().parents[1])
    except BaseException as exc:
        sys.stderr.write(f"vendor verification failed: {exc}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
