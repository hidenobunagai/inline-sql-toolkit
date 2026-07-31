# Release guide

This guide is the release checklist for a maintainer producing a local,
reviewable Inline SQL Toolkit VSIX. It deliberately ends before Marketplace
publication: publishing requires a separate, explicit approval for that
release.

## 1. Version and changelog

1. Confirm the intended version in `package.json`, the Python project metadata,
   and the VSIX filename. The current release is **0.1.0**.
2. Add a dated `0.1.0` (or next-version) entry to `CHANGELOG.md` describing
   user-visible behavior, safety boundaries, and compatibility changes.
3. Review the README, security/support guidance, and third-party notices for
   claims that match the implementation. Keep the existing MIT project license
   and all third-party license text unchanged.
4. Check the diff and ensure `.DS_Store`, generated `dist/`, `dist-vsix/`,
   coverage, reports, and local caches are not staged.

## 2. Clean, frozen verification

Use the pinned tools (Bun **1.3.8**, uv **0.9.28**) and install only frozen
lockfile contents:

```bash
bun install --frozen-lockfile --ignore-scripts
uv sync --frozen --python 3.12
bun run format:check
bun run lint
bun run typecheck
bun run test:coverage
VSCODE_TEST_VERSION=1.95.0 bun run test:grammar
VSCODE_TEST_VERSION=stable bun run test:grammar
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest --cov
```

Run the complete Extension Host matrix (trusted and untrusted) at both the
minimum and stable VS Code versions:

```bash
VSCODE_TEST_VERSION=1.95.0 bun run test:integration:trusted
VSCODE_TEST_VERSION=1.95.0 bun run test:integration:untrusted
VSCODE_TEST_VERSION=stable bun run test:integration:trusted
VSCODE_TEST_VERSION=stable bun run test:integration:untrusted
```

The cross-platform CI matrix remains authoritative for Ubuntu, macOS, and
Windows with Python 3.12, 3.13, and 3.14. A local release must not be called
compatible when a required matrix job is unavailable or failed.

## 3. Security and dependency gates

Run the vendor verifier and OSV scan inputs before accepting an artifact:

```bash
uv run python tools/verify_vendor.py
uv run python tools/verify_vendor.py --lock-projection-only
```

The CI OSV jobs scan `bun.lock`, `uv.lock`, and
`tools/sqlparse-vendor.requirements.txt`. Resolve every finding or document a
reviewed exception before proceeding. Do not substitute an unpinned runtime
dependency for the vendored sqlparse tree.

## 4. Build, inspect, and smoke-test the VSIX

Build the artifact without dependency traversal, then verify its exact
inventory, provenance, licenses, and component report:

```bash
bun run package:vsix
uv run python tools/verify_vsix.py \
  dist-vsix/inline-sql-toolkit-0.1.0.vsix \
  --report reports/vsix-components.osv.json
bun run test:vsix-install -- \
  dist-vsix/inline-sql-toolkit-0.1.0.vsix
```

Generate a reproducible inventory and SHA-256 artifact record:

```bash
unzip -Z1 dist-vsix/inline-sql-toolkit-0.1.0.vsix \
  > reports/vsix-inventory.txt
shasum -a 256 dist-vsix/inline-sql-toolkit-0.1.0.vsix \
  > reports/inline-sql-toolkit.vsix.sha256
```

Inspect the real archive, not only the source tree. It must include the
allowlisted helper `.py` files, grammars, `sqlparse` BSD-3-Clause records, the
Microsoft Python Extension API facade MIT record, and user-facing license,
README, changelog, security, support, and notice files. It must exclude
TypeScript/development source, absolute build paths, fixture secrets, caches,
bytecode, tests, plans/specs, lockfiles, `node_modules`, and unapproved runtime
dependencies.

Run the offline smoke against the pinned image. The image digest is part of the
acceptance evidence; do not replace it with a mutable tag:

```bash
uv run python tools/offline_vsix_smoke.py \
  --vsix dist-vsix/inline-sql-toolkit-0.1.0.vsix \
  --request test/fixtures/helper/offline-request.json \
  --image python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de
```

The smoke must run with no network and a read-only container, and must leave no
source-bearing temporary tree behind. Record the verifier output, component
report, inventory, SHA-256, and offline result together with the release review.

## 5. Publisher identity and approval boundary

The intended Marketplace publisher identity is **`hidenobunagai`**, matching the
`publisher` field in `package.json`. Verify that identity and the release
version in the final VSIX before any publication discussion.

Marketplace publication is a separate action. Do not run `vsce publish`, upload
the VSIX, or create Marketplace credentials as part of this checklist. Obtain a
new, explicit approval naming the exact version and artifact SHA-256 first;
only then may an authorized maintainer perform publication and record the
result.
