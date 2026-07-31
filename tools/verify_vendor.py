"""Verify the checked-in sqlparse vendor tree and its provenance records."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from vendor_sqlparse import (
    VendorError,
    parse_inventory,
    read_lock,
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
    for key in ("name", "version", "url", "wheel", "sha256", "license"):
        if source.get(key) != lock[key]:
            raise VendorError("source provenance disagrees with vendor lock")
    if (
        not (third_party / "LICENSE").is_file()
        or not (third_party / "AUTHORS").is_file()
    ):
        raise VendorError("missing third-party notices")
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
