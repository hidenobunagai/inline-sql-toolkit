# Development guide

This guide is for contributors who change Inline SQL Toolkit and need a
repeatable local check. It covers the repository's quality gates and the
runtime privacy boundary; it does not describe Marketplace publishing.

## Prerequisites

- Node.js 22 for development tooling and Node.js 20 for checking the generated
  extension bundle.
- Bun **1.3.8** (the version pinned by `packageManager` and CI).
- uv **0.12.1** (the version pinned by CI).
- Python 3.12 or newer, used only through `uv run` for `tools/verify_vsix.py`.
- VS Code 1.95.0 for the minimum Extension Host gate and a current stable VS
  Code build for compatibility checks.

The extension runs no Python at runtime: the analysis pipeline is TypeScript and
the formatter is the bundled `sql-formatter` package. There is no helper process
or checked-in vendor tree to satisfy, and no `PYTHONPATH` to arrange; the frozen
uv environment exists only to run the packaging verifier below.

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

The TextMate grammar is a release boundary. There is no separate grammar suite;
the grammar is asserted where it is contributed and where detection is recorded.
Run this check before working on formatter behavior:

```bash
bunx vitest run test/ts/manifest.test.ts test/ts/detection-fixtures.test.ts
```

If even one manifest grammar assertion or detection fixture fails, stop. Record
the failing case in the review and return to the grammar design. Do not weaken
the acceptance case, silently switch to semantic tokens, fork the Python
grammar, or continue to later feature work until the design review resolves the
failure.

## Vendor refresh: nothing to refresh

There is no vendor refresh to run. `sqlparse`, the Python helper,
`tools/vendor_sqlparse.py`, `tools/sqlparse-vendor.lock`,
`tools/verify_vendor.py`, and the `third_party/sqlparse/` tree were removed with
the formatter migration (see `docs/formatter-migration.md`). `third_party/` now
holds only the `inline-sql-syntax` grammar license and grammar file, and the
extension's single runtime dependency is the pinned `sql-formatter` npm package,
which esbuild inlines into `dist/extension.js` from `bun.lock`.

Packaging integrity is a `tools/verify_vsix.py` concern, not a vendoring one: it
validates the exact archive inventory and rejects forbidden content before a
VSIX is accepted. Run it with the packaging steps below.

## Unit, property, and integration checks

Run the focused test while iterating, then the complete local suites:

```bash
bun run test:unit -- test/ts/manifest.test.ts
bun run test:unit
bun run test:coverage
```

There are no Python gates to run. `pyproject.toml` declares no dependencies and
the Python helper, its vendored `sqlparse` tree, and the `test/python` suite with
its Hypothesis property tests were removed with the formatter migration, so
`pytest`, `ruff`, and `ty` are not installed. The TypeScript suites in `test/ts`
own source positions, f-strings, and protection invariants now, and they run
inside `bun run test:coverage`.

Exercise both trusted and untrusted Extension Host scenarios at the minimum and
stable VS Code versions:

```bash
VSCODE_TEST_VERSION=1.95.0 bun run test:integration:trusted
VSCODE_TEST_VERSION=1.95.0 bun run test:integration:untrusted
VSCODE_TEST_VERSION=stable bun run test:integration:trusted
VSCODE_TEST_VERSION=stable bun run test:integration:untrusted
```

## Package inspection

Build a local VSIX, then inspect it with the archive verifier. The filename is
derived from the `package.json` version, as it is in CI, and generated artifacts
belong in ignored directories and are not source changes:

```bash
bun run package:vsix
vsix="dist-vsix/inline-sql-toolkit-$(node -p "require('./package.json').version").vsix"
uv run python tools/verify_vsix.py "$vsix"
unzip -Z1 "$vsix"
```

The inventory is an exact allowlist, not a pattern. The archive must contain only
the packaged manifest and its localized manifests, `readme.md`, `changelog.md`,
`LICENSE.txt`, `SECURITY.md`, `SUPPORT.md`, `THIRD_PARTY_NOTICES.md`, `icon.png`,
`icon.svg`, the injected TextMate grammar, `dist/extension.js`,
`dist/package.json`, and the `inline-sql-syntax` third-party license and grammar.
It must not contain TypeScript/development source, source maps, lockfiles,
caches, tests, plans, absolute build paths, fixture secrets, bytecode,
`node_modules`, or an unapproved runtime dependency. No Python helper or vendored
tree is packaged: the analyzer is the generated CommonJS bundle with
`sql-formatter` inlined.

## Privacy rules

Do not add telemetry, analytics, network calls, database calls, shell execution,
or source logging. The extension is one in-process TypeScript bundle, so document
text may cross only the typed request and edit values in `src/protocol.ts`;
source must not be written to disk or included in test reports, snapshots,
diagnostics, or commit messages. Test fixtures must use synthetic or redacted
text and must never contain credentials, customer data, tokens, or private paths.

When a change touches trust, the analysis pipeline, or package inventory, add a
focused test and rerun the complete verification sequence before requesting
review.
