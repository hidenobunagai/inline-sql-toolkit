# Release guide

This guide is the release checklist for a maintainer producing a local,
reviewable Inline SQL Toolkit VSIX. It deliberately ends before Marketplace
publication: publishing requires a separate, explicit approval for that
release.

## 1. Version and changelog

1. Confirm the intended version in `package.json`, the Python project metadata,
   and the VSIX filename. The current release is **0.4.6**.
2. Add a dated `0.4.6` (or next-version) entry to `CHANGELOG.md` describing
   user-visible behavior, safety boundaries, and compatibility changes.
3. Review the README, security/support guidance, and third-party notices for
   claims that match the implementation. Keep the existing MIT project license
   and all third-party license text unchanged.
4. Check the diff and ensure `.DS_Store`, generated `dist/`, `dist-vsix/`,
   coverage, reports, and local caches are not staged.

## 2. Clean, frozen verification

Use the pinned tools (Bun **1.3.8**, uv **0.12.1**) and install only frozen
lockfile contents:

```bash
bun install --frozen-lockfile --ignore-scripts
uv sync --frozen --python 3.12
bun run format:check
bun run lint
bun run typecheck
bun run test:coverage
```

There is no separate Python gate to run. `pyproject.toml` declares no
dependencies and the Python helper, its vendored `sqlparse` tree, and the
`test/python` suite were removed with the formatter migration (see
`docs/formatter-migration.md`), so `ruff`, `ty`, and `pytest` are not
installed. The uv environment exists to run `tools/verify_vsix.py` in
section 4. The grammar has no dedicated suite either: the manifest test
asserts the injected grammar contribution and file, and the detection fixtures
record the grammar expectation; both run inside `bun run test:coverage`.

Run the complete Extension Host matrix (trusted and untrusted) at both the
minimum and stable VS Code versions:

```bash
VSCODE_TEST_VERSION=1.95.0 bun run test:integration:trusted
VSCODE_TEST_VERSION=1.95.0 bun run test:integration:untrusted
VSCODE_TEST_VERSION=stable bun run test:integration:trusted
VSCODE_TEST_VERSION=stable bun run test:integration:untrusted
```

The cross-platform CI matrix remains authoritative for Ubuntu, macOS, and
Windows at VS Code 1.95.0 and stable. A local release must not be called
compatible when a required matrix job is unavailable or failed.

## 3. Security and dependency gates

There is no vendor verifier to run. The formatter engine is the pinned
`sql-formatter` npm dependency, and the Python helper and vendored `sqlparse`
tree were removed with the formatter migration (see
`docs/formatter-migration.md`). Dependency scanning happens in CI over three
inputs:

- `bun.lock` and `uv.lock`: scanned by the OSV scanner for every pull request
  and every push to `main`, with a weekly scheduled run as a backstop.
- `reports/vsix-components.osv.json`: the component report written in the
  `package` job by
  `uv run python tools/verify_vsix.py <vsix> --report reports/vsix-components.osv.json`
  and scanned from the uploaded artifact by the `osv-packaged-components` job,
  which is the gate for a component that appears only inside the packaged VSIX.

Confirm those jobs are green on the `main` commit being released and that code
scanning has no open alert for them. Resolve every finding or document a
reviewed exception before proceeding. Do not add an unvetted runtime
dependency: `sql-formatter` is the extension's only runtime dependency.

## 4. Build, inspect, and smoke-test the VSIX

Build the artifact without dependency traversal, then verify its exact
inventory, provenance, licenses, and component report. The VSIX filename is
derived from the `package.json` version, as it is in CI:

```bash
bun run package:vsix
vsix="dist-vsix/inline-sql-toolkit-$(node -p "require('./package.json').version").vsix"
uv run python tools/verify_vsix.py "$vsix" \
  --report reports/vsix-components.osv.json
bun run test:vsix-install -- "$vsix"
```

Generate a reproducible inventory and SHA-256 artifact record:

```bash
unzip -Z1 "$vsix" > reports/vsix-inventory.txt
shasum -a 256 "$vsix" > reports/inline-sql-toolkit.vsix.sha256
```

Inspect the real archive, not only the source tree. `tools/verify_vsix.py`
accepts only the exact inventory it knows: the manifest and localized
manifests, the user-facing license, README, changelog, security, support, and
notice files, the generated `dist/extension.js` bundle, `dist/package.json`,
the icons, the injected TextMate grammar, and the third-party license and
grammar files under `third_party/` (`inline-sql-syntax`, `sql-formatter`,
`nearley`). It must exclude TypeScript/development source,
absolute build paths, fixture secrets, caches, bytecode, tests, plans/specs,
lockfiles, `node_modules`, and unapproved runtime dependencies.

There is no container-based offline smoke to run: its driver
`tools/offline_vsix_smoke.py`, its `test/fixtures/helper/offline-request.json`
request, and the Python helper tree it exercised were removed with the
formatter migration (see `docs/formatter-migration.md`). The installed-VSIX
smoke above is the artifact-level check; the bundle inlines `sql-formatter`,
the extension's only runtime dependency, so the installed extension needs no
network access.

Record the verifier output, component report, inventory, and SHA-256 together
with the release review.

## 5. Publisher identity and approval boundary

The intended Marketplace publisher identity is **`hidenobunagai`**, matching the
`publisher` field in `package.json`. Verify that identity and the release
version in the final VSIX before any publication discussion.

Marketplace publication is a separate action. Do not run `vsce publish`, upload
the VSIX, or create Marketplace credentials as part of this checklist. Obtain a
new, explicit approval naming the exact version and artifact SHA-256 first;
only then may an authorized maintainer perform publication and record the
result.

## 6. npm publication (trusted publishing / OIDC)

In addition to the VS Code extension VSIX, the CLI executable is published to npm
as `inline-sql-toolkit`.

Publishing uses npm Trusted Publishing via GitHub Actions OIDC
(`permissions: { contents: read, id-token: write }`), avoiding long-lived npm
tokens.

- **Initial bootstrap** (already done for 0.4.7; needed again only for a brand-new
  package name): a trusted publisher can only be registered on a package that
  already exists, so the very first release cannot use OIDC. Create a **granular
  access token** on npm with `All packages` + `Read and write (publish and
stage)`, **Bypass two-factor authentication** enabled, and a short expiry (7
  days is enough), then publish that one version from a checkout:
  1. Put the token in `.npmrc` (`//registry.npmjs.org/:_authToken=<token>`) or
     export it as `NODE_AUTH_TOKEN`.
  2. `bun install --frozen-lockfile --ignore-scripts && bun run build`
  3. `npm publish --access public`
  4. Register the trusted publisher at
     `https://www.npmjs.com/package/inline-sql-toolkit/access` → **Trusted
     Publisher** → GitHub Actions: organization/user `hidenobunagai`, repository
     `inline-sql-toolkit`, workflow filename `publish.yml` (filename only, exact,
     case-sensitive).
  5. Revoke the token and remove it from `.npmrc`.
     The workflow deliberately has **no token path**: a stray `NPM_TOKEN` secret must
     not be able to silently take over the npm job. A passkey-only npm account cannot
     satisfy 2FA from the CLI (there is no TOTP to pass to `--otp`), which is exactly
     why the bootstrap token is the only way in and why the steady state is OIDC.
- **First real OIDC release**: the workflow skips publishing when the version is
  already on npm, so dispatching it cannot exercise OIDC — the first release after
  the bootstrap is the first real test. If it fails with
  `Unable to authenticate`, the repository or workflow filename registered as the
  trusted publisher does not match this repository (`publish.yml`, case-sensitive).
- **Workflow separation**: The `npm` job in `.github/workflows/publish.yml` is
  isolated from the VSIX publication job so that either registry can be retried
  independently without touching the other.
- **Tarball verification**: Test the packaging contents locally before release:
  ```bash
  npm pack --dry-run
  ```
  Confirm that **`dist/cli.js` and `dist/package.json` are both present** — the
  latter marks `dist/` as CommonJS, and 0.4.7 shipped without it, so the published
  CLI died with `module is not defined in ES module scope` — and that
  `dist/extension.js`, source code, and tests are excluded.
