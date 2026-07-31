"""Fixed-path runtime bootstrap for the packaged Python helper."""

from __future__ import annotations

import importlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType


@dataclass(frozen=True, slots=True)
class RuntimeContext:
    python_root: Path
    vendor_root: Path
    sqlparse: ModuleType


def prepare_runtime() -> RuntimeContext:
    python_root = Path(__file__).resolve().parent
    vendor_anchor = python_root / "vendor"
    if vendor_anchor.parent.is_symlink() or vendor_anchor.is_symlink():
        raise RuntimeError("invalid vendored runtime")
    vendor_root = vendor_anchor.resolve()
    if vendor_root != vendor_anchor:
        raise RuntimeError("invalid vendored runtime")
    sys.dont_write_bytecode = True
    sys.path[:0] = [str(vendor_root), str(python_root)]
    sqlparse = importlib.import_module("sqlparse")
    module_file = Path(sqlparse.__file__).resolve()
    if getattr(
        sqlparse, "__version__", None
    ) != "0.5.5" or not module_file.is_relative_to(vendor_root):
        raise RuntimeError("invalid vendored runtime")
    return RuntimeContext(python_root, vendor_root, sqlparse)


def self_check(runtime: RuntimeContext) -> int:
    response = {
        "ok": True,
        "sqlparseVersion": runtime.sqlparse.__version__,
        "vendored": True,
    }
    sys.stdout.write(json.dumps(response, separators=(",", ":")))
    return 0


def entrypoint() -> int:
    try:
        runtime = prepare_runtime()
        if sys.argv[1:] == ["--self-check"]:
            return self_check(runtime)
        return 70
    except BaseException:
        return 70


if __name__ == "__main__":
    raise SystemExit(entrypoint())
