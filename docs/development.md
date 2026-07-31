# Development guide

This guide is for contributors who change Inline SQL Toolkit and need a
repeatable local check. It covers the repository's quality gates and the
runtime privacy boundary; it does not describe Marketplace publishing.

## Prerequisites

- Node.js 22 for development tooling and Node.js 20 for checking the generated
  extension bundle.
- Bun **1.3.8** (the version pinned by `packageManager` and CI).
- uv **0.9.28** (the version pinned by CI).
- Python 3.12 or newer. The test matrix also runs Python 3.13 and 3.14.
- VS Code 1.95.0 for the minimum Extension Host gate and a current stable VS
  Code build for compatibility checks.

Do not use a user-site Python package or `PYTHONPATH` to satisfy the helper's
runtime imports. The packaged helper runs with its isolated `-I -S` command and
the checked-in vendor tree; it does not depend on the repository uv environment.
The frozen uv environment is for development tools and tests only.

## Frozen setup

From the repository root, install exactly the lockfile contents:

```bash
bun install --frozen-lockfile --ignore-scripts
uv sync --frozen --python 3.12
```

The lockfiles are review artifacts. Do not regenerate them with a newer Bun or
uv and then claim that the frozen check passed. If a dependency must change,
update the lock deliberately and rerun every verification command in the
release guide.

## Grammar gate: hard stop

The TextMate grammar is a release boundary. Run both grammar suites before
working on formatter behavior:

```bash
VSCODE_TEST_VERSION=1.95.0 bun run test:grammar
VSCODE_TEST_VERSION=stable bun run test:grammar
```

If even one PEP 701 or SQL-island acceptance case fails in either VS Code
version, stop. Record the failing case and grammar/version in the review, and
return to the grammar design. Do not weaken the acceptance case, silently
switch to semantic tokens, fork the Python grammar, or continue to later
feature work until the design review resolves the failure.

## Vendor refresh and integrity check

`sqlparse` 0.5.5 is vendored for offline runtime use. A refresh is an explicit
supply-chain operation and must use the pinned lock projection:

```bash
uv run python tools/vendor_sqlparse.py --lock tools/sqlparse-vendor.lock
uv run python tools/verify_vendor.py
uv run python tools/verify_vendor.py --lock-projection-only
```

Review the wheel URL, SHA-256, BSD-3-Clause license, AUTHORS file, and
`third_party/sqlparse/SOURCE.json` together. Never hand-edit a vendored source
file. The verifier must pass before packaging; it also checks that the
byte-for-byte vendor tree and provenance files agree.

## Unit, property, and integration checks

Run the focused test while iterating, then the complete local suites:

```bash
bun run test:unit -- test/ts/manifest.test.ts
bun run test:unit
bun run test:coverage
uv run pytest test/python -q
uv run pytest --cov
uv run ruff check .
uv run ruff format --check .
uv run ty check
```

The Python suite includes Hypothesis property tests for source positions,
f-strings, and protection invariants. Exercise both trusted and untrusted
Extension Host scenarios at the minimum and stable VS Code versions:

```bash
VSCODE_TEST_VERSION=1.95.0 bun run test:integration:trusted
VSCODE_TEST_VERSION=1.95.0 bun run test:integration:untrusted
VSCODE_TEST_VERSION=stable bun run test:integration:trusted
VSCODE_TEST_VERSION=stable bun run test:integration:untrusted
```

## Package inspection

Build a local VSIX, then inspect it with the archive verifier. Generated
artifacts belong in ignored directories and are not source changes:

```bash
bun run package:vsix
uv run python tools/verify_vendor.py
uv run python tools/verify_vsix.py \
  dist-vsix/inline-sql-toolkit-0.1.0.vsix
unzip -Z1 dist-vsix/inline-sql-toolkit-0.1.0.vsix
```

The inventory must contain the allowlisted Python helper, vendored sqlparse,
grammars, notices, and generated CommonJS bundle. It must not contain
TypeScript/development source, source maps, lockfiles, caches, tests, plans,
absolute build paths, fixture secrets, bytecode, `node_modules`, or an
unapproved runtime dependency. The allowlisted helper `.py` files are required
runtime code, not accidental development files.

## Privacy rules

Do not add telemetry, analytics, network calls, database calls, shell execution,
or source logging. Document text may cross only the local versioned protocol
between the extension and its one-shot helper. The helper's stdout and stderr
must stay source-free; source must not be written to disk or included in test
reports, snapshots, diagnostics, or commit messages. Test fixtures must use
synthetic or redacted text and must never contain credentials, customer data,
tokens, or private paths.

When a change touches trust, process spawning, package inventory, or protocol
validation, add a focused test and rerun the complete verification sequence
before requesting review.
