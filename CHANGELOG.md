# Changelog

## 0.4.13 - 2026-09-25

- Changed: `inlineSql.format.commaPosition: "before"` now emits the moved
  comma with no following space — `id` / `    ,name` instead of `, name` —
  per user feedback. The default `after` output is byte-for-byte unchanged,
  and the mover's safety rules are identical: commas inside string literals,
  `$$ … $$` bodies, and comments are still never touched.

## 0.4.12 - 2026-09-24

- Feature: added the `inlineSql.format.keepFunctionsInline` setting (default
  `false`). `sql-formatter` has no option that holds function arguments on
  one line — it breaks `CASE` structurally regardless of `wrapAfter` — so the
  extension re-joins the line breaks the engine inserts inside `word(...)`
  groups as a post-pass over its output. With the setting on,
  `COUNT(CASE WHEN a THEN 1 ELSE 0 END)` stays on a single line while select
  lists, clause breaks, and `AND` / `OR` chains keep their usual layout.
- The same choice is exposed everywhere the other options are: the VS Code
  setting, the CLI flag `--keep-functions-inline`, and
  `"keepFunctionsInline"` in `.inline-sql.json`, under the unchanged CLI
  flags > configuration file > defaults precedence.
- Safety: only newlines in code state are removed. A newline inside a string
  literal, a `$$ … $$` body, or a block comment is copied verbatim, and the
  newline that terminates a `-- line comment` is kept, so literal content can
  never change and no code can fall into a comment. The default `false`
  reproduces the previous output byte for byte, and the fixed-point loop still
  skips any candidate whose formatting does not converge.

## 0.4.11 - 2026-09-24

- Feature: added the `inlineSql.format.commaPosition` setting (`after` |
  `before`, default `after`) for codebases that want a wrapped item's comma at
  the start of the next line instead of the end of the previous one. The
  default reproduces the previous output byte for byte, so existing files do
  not move until the setting is turned on; `before` emits the comma at the
  next line's indent in front of the item, and a trailing `-- comment` stays
  with its own column (`order_id -- note` followed by `, order_date -- note`)
  rather than pinning the comma behind it.
- The same choice is exposed everywhere the other options are: the VS Code
  setting, the CLI flag `--comma-position after|before`, and
  `"commaPosition"` in `.inline-sql.json`, under the unchanged CLI flags >
  configuration file > defaults precedence.
- Safety: `sql-formatter` removed its own `commaPosition` option long ago, so
  the move is a small post-pass over its output. A scanner locates the
  wrapping separator comma and never moves one from inside a quoted string
  (`'...'`, `"..."`, backticks) or from after a `--` line comment, and a
  candidate whose output still fails to converge to a fixed point is skipped
  untouched as before, so no file can be rewritten with corrupted SQL.

## 0.4.10 - 2026-09-19

- CI: the npm publish job is now OIDC-only. The dormant `NPM_TOKEN` path that was
  kept for the one-time 0.4.7 bootstrap is gone, so a stray token secret can no
  longer silently take precedence over trusted publishing — one did, and it would
  have expired a week later. npm exchanges the GitHub OIDC token for a
  short-lived publish credential and attaches provenance attestations, matching
  the setup already used by `sql-template-formatter`.
- Documentation: `docs/releasing.md` now records the bootstrap as a one-time
  local publish that is needed only for a brand-new package name: install with
  `bun install --frozen-lockfile --ignore-scripts`, build with `bun run build`,
  then `npm publish`. It also states that dispatching the workflow can no longer
  verify OIDC, because the publish is skipped when the version is already on npm:
  the next release is the first real test of the credential exchange.
- Documentation: the tarball check now requires `dist/cli.js` and
  `dist/package.json` together: the latter marks `dist/` as CommonJS, and 0.4.7
  shipped without it, so the published CLI died with the error
  `module is not defined in ES module scope`.
- No formatting behavior changes and no code changes: this release is publish
  workflow and release-documentation only.

## 0.4.9 - 2026-09-18

- CI: the Open VSX publish step now retries up to four times with a 30-second
  pause between attempts instead of failing the release on the first response.
  Open VSX answers 503 intermittently and can even fail the request after
  accepting the upload; `--skip-duplicate` makes a retry harmless in that case,
  because an already-published version reports success.
- CI: the npm publish job is now idempotent. Re-running the workflow to retry
  the marketplaces (for example after an Open VSX 503) no longer turns the npm
  job red: it asks the registry whether the version is already published and
  skips both publish steps when it is, so the retry cannot fail with "cannot
  publish over the previously published versions".
- No formatting behavior changes and no code changes: this release is publish
  workflow robustness only.

## 0.4.8 - 2026-09-17

### Fixed

- **The published CLI could not start.** 0.4.7 shipped without `dist/package.json`, which marks `dist/` as CommonJS while the root manifest says `"type": "module"`, so Node loaded the CJS bundle as ESM and every invocation died with `module is not defined in ES module scope`. `.npmignore` no longer excludes that file, the publish workflow now fails unless the tarball contains both `dist/cli.js` and `dist/package.json`, and `test/ts/cli.test.ts` packs the tarball, extracts it, and runs the CLI from the extracted tree — the only layer where this class of packaging bug is visible.

## 0.4.7 - 2026-09-17

### Added

- CLI: added the `inline-sql-toolkit` command-line executable bundled at `dist/cli.js`, enabling offline Python inline SQL formatting directly from the shell or CI workflows without adding new dependencies.
- CLI: supports `-w`/`--write` in-place formatting, `--check` validation mode, stdin/stdout streaming, and hierarchical `.inline-sql.json` configuration resolution.
- Packaging: prepared npm package distribution for the CLI with `.npmignore` scoping the tarball to `dist/cli.js` and documentation, and added an npm publish workflow job (trusted publishing / OIDC, with a token path for the one-time bootstrap).

### Changed

- Architecture: extracted pure shared modules (`src/format-options.ts`, `src/replacement.ts`, `src/sql-formatter.ts`) so both the VS Code extension and the CLI share identical configuration validation, single-line literal collapsing, and formatting logic.
- Manifest: updated `package.json` engines to `{ "vscode": "^1.95.0", "node": ">=20" }`, registered the CLI bin entry, and un-privatized the package for npm publishing while keeping `.vscodeignore` excluding the CLI from the VSIX.

## 0.4.6 - 2026-09-16

- Support documentation: the `SUPPORT.md` diagnostic checklist no longer asks
  for a Python version. The extension never runs a Python interpreter — the
  analyzer is TypeScript and the formatter is the bundled `sql-formatter` — so
  the request was a leftover from the removed helper era; the literal shape that
  actually matters is still requested in the paragraph above the list, and the
  packaged reason-code table is unchanged.
- Maintenance: drops the dead `.pytest_cache/`, `.ruff_cache/`, and
  `.hypothesis/` entries from `.gitignore`, since pytest, ruff, and hypothesis
  left with the Python test suite and no longer have anything to ignore. The
  lines could only go once the stale cache directories were removed from the
  working copy, because prettier reads `.gitignore` as an ignore path and was
  kept off them by those entries. `__pycache__/` and `*.py[cod]` stay, because
  `uv run python tools/verify_vsix.py` still writes them.
- No formatting behavior changes and no code changes: this release is
  documentation and repository-configuration hygiene only.

## 0.4.5 - 2026-09-15

- Licensing: the packaged VSIX now ships the MIT license text of every npm
  package esbuild inlines into `dist/extension.js` — `sql-formatter` 15.8.2 and
  the `nearley` 2.20.1 parser it imports — instead of describing the injected
  grammar as the only packaged component. The bundle sets
  `legalComments: "none"`, so the notices are stripped from the code and have to
  travel in `third_party/` and `THIRD_PARTY_NOTICES.md`.
- Security/CI: the `osv-packaged-components` report is now derived from the
  `THIRD_PARTY_NOTICES.md` inside the verified VSIX and cross-checked against
  the packaged `third_party/` tree, replacing the hardcoded package list. A
  dependency entering or leaving the bundle can no longer leave the scanner
  input silently stale, and an unreadable or missing notice fails verification
  instead of reporting nothing.
- Support documentation: the `SUPPORT.md` diagnostic reference lists exactly the
  13 reason codes the extension can emit (`REASON_CODES` in `src/constants.ts`),
  replacing the four helper-era codes (`PYTHON_NOT_FOUND`,
  `PYTHON_VERSION_UNSUPPORTED`, `DOCUMENT_PARSE_FAILED`, `PROCESS_TIMEOUT`) and
  the removed-helper wording; the README troubleshooting bullet no longer names
  `PROCESS_TIMEOUT`.
- Maintenance: drops the unused `vscode-textmate` and `vscode-oniguruma`
  devDependencies, the stale `ruff` hooks from `.pre-commit-config.yaml` (the uv
  environment has held no Python dependencies since the formatter migration, so
  every `pre-commit run` failed), and the ignore entries for the removed
  `python/vendor` and `test/.grammar-cache` paths.
- Manifest tests guard both classes of drift: the documented reason codes must
  match `REASON_CODES`, and every `node_modules/` input of the esbuild metafile
  must have a `third_party/` directory linked from the packaged notices, with
  the declared version matching the package actually inlined.
- No formatting behavior changes: this release is license/notice compliance,
  component-report integrity, documentation alignment, and stale-configuration
  cleanup only.

## 0.4.4 - 2026-09-14

- Security/CI: the OSV lockfile scan now also runs on every push to `main`
  instead of waiting for a pull request or the weekly scheduled run, so an
  advisory in `bun.lock` / `uv.lock` is reported on the commit that lands it.
- Pins patched versions of OSV-flagged dev dependencies (`vitest` and
  `@vitest/coverage-v8` 4.1.11, `fast-uri` 3.1.6, `js-yaml` 4.3.2, and a new
  `qs` 6.16.0 override). The shipped runtime dependency (`sql-formatter`) is
  unchanged.
- CI: the installed-VSIX smoke now actually runs and its result is asserted
  through the shared `testInstalledVsixSmoke` helper (which gained pass/fail
  coverage): the fixture driver declares `onStartupFinished` so VS Code
  activates it, and the job no longer ignores failures, so a broken packaged
  extension fails the build instead of leaving CI green.
- Documentation: `docs/releasing.md` and `docs/development.md` now describe the
  current toolchain and gates instead of the removed Python helper, vendored
  `sqlparse` tree, vendor verifier, and container-based offline smoke;
  `SECURITY.md` and `THIRD_PARTY_NOTICES.md` no longer claim the removed
  `sqlparse` and `@vscode/python-extension` components, and `.vscodeignore`
  drops its stale `python/` allowlist rules. The manifest tests guard the
  notices against `third_party/` and every allowlist entry against the
  repository.
- No formatting behavior changes: this release is CI, dependency, test, and
  documentation maintenance only.

## 0.4.3 - 2026-09-13

- Removes the redundant `onCommand:` activation events from the extension
  manifest: VS Code synthesizes them from `contributes.commands`, so the three
  format commands keep working and the extension still activates only for
  Python and marimo Python documents.
- Pins patched versions of OSV-flagged transitive dependencies
  (`brace-expansion`, `fast-uri`, `js-yaml`, `nanoid`, `postcss`, `undici`)
  through `overrides`; the shipped runtime dependency is unchanged.
- Packaging: agent tool configuration (`.claude/`, `.cursor/`, `.mcp.json`,
  `opencode.jsonc`, and related files) and the root documentation diagram PNGs
  are excluded from the VSIX, keeping the verified file inventory exact.
- Documentation: adds overview diagrams and an architecture diagram to the
  README, and publishes the architecture diagram to GitHub Pages.
- Internal/CI with no formatting behavior changes: adds the automated Publish
  workflow (VS Code Marketplace and Open VSX on tag), downloads the integration
  test VS Code build with a resume-capable curl instead of the flaky streaming
  downloader, pins uv 0.12.1, raises the integration test timeout to 60s, and
  removes the legacy Cursor/Kiro/Qoder/CodeBuddy/Gemini/Serena artifacts.

This is the first tagged release since v0.4.1: the 0.4.2 fixes documented below
were published to the marketplaces without a tag and are contained in this
release as well.

## 0.4.2 - 2026-08-06

- Updates the error messages shown when formatting fails or produces an
  invalid response: they no longer reference the removed helper process
  and describe the failure directly.
- The `Inline SQL Toolkit` output channel's format summary now lists the
  dialect and every layout setting (keyword case, indent width, wrap
  width, operator spacing, ordinal replacement) exactly once.
- Internal cleanup with no formatting behavior changes: drops the dead
  grammar test glob, renames the Python project metadata to match the
  extension, and excludes local agent tool configuration from formatting
  checks.

## 0.4.1 - 2026-08-05

- Fixes SQL corruption when a query contains a Python `%`-style
  placeholder: `%s`, `%(name)s`, `%04d`, and `%%` were reformatted as
  `% s` etc. and broke the query. Placeholders are now kept intact
  exactly as written. The modulo operator (`a % 2`) still formats
  normally.
- Fixes `GROUP BY`/`ORDER BY` ordinal replacement duplicating a
  `%`-placeholder when the referenced column expression contained one;
  the ordinal now stays in place.

## 0.4.0 - 2026-08-05

- Removes the no-op `inlineSql.format.expandSelectList` and
  `inlineSql.format.trimBlankBoundaries` settings: they were read and
  validated but never applied by the formatter. Existing user
  configurations for these settings are ignored without error.
- Internal cleanup with no formatting behavior changes: drops the
  code-action locate cache, unused `SourceMap` AST/token offset
  conversions, the dead helper-process fixture loader and protocol
  fields, and the never-fired process-spawn test hooks.

## 0.3.38 - 2026-08-04

- Fixes `FORMATTER_FAILED (not idempotent)` skips caused by sql-formatter
  toggling between one-line and expanded layouts (e.g. `CASE` expressions
  next to comments): formatting now converges to the stable layout instead of
  rejecting the candidate.
- Fixes `GROUP BY` ordinal replacement emitting invalid SQL when the select
  column has a comment after its alias (e.g. `END AS label /* テキスト */`):
  the alias is now detected, so `GROUP BY label` is used.
- The debug output channel now logs the full line-by-line diff when
  convergence fails, and the format summary includes the dialect and layout
  settings.

## 0.3.37 - 2026-08-04

- Adds an `Inline SQL Toolkit` output channel that logs why a candidate was
  skipped: the skip reason, the failing detail (parse error, field-text
  mismatch, idempotency diff), and the literal content. Open it via
  View -> Output after a format to diagnose `FORMATTER_FAILED` /
  `UNSAFE_FSTRING_RESTORE` skips.

## 0.3.36 - 2026-08-04

- Fixes formatting being skipped entirely (`FORMATTER_FAILED` /
  `UNSAFE_FSTRING_RESTORE`) when a `GROUP BY` ordinal referenced a select
  column containing an f-string field (e.g. `ci.{parameter} /* テキスト */`):
  the field is no longer copied into the clause, so it is not duplicated and
  the f-string safety gate passes. The ordinal stays in place; columns
  without fields (or with an alias) still resolve as before.

## 0.3.35 - 2026-08-04

- Stops comments from leaking into `GROUP BY` / `ORDER BY` when ordinals are
  replaced: a trailing comment on a select expression (e.g. `userid /* テキスト */`)
  is no longer copied into the clause, a comment between an expression and its
  implicit alias no longer blocks alias detection, and an ordinal followed by a
  comment (e.g. `GROUP BY 1 /* c */`) still resolves.

## 0.3.34 - 2026-08-04

- Resolves `GROUP BY` / `ORDER BY` ordinals in more real-world queries:
  `QUALIFY` and `WITH ROLLUP` no longer swallow trailing ordinals, direction
  suffixes (`DESC`, `ASC`, `NULLS LAST`) stay on the replaced column, each
  `UNION ALL` branch resolves against its own select list, fully qualified
  column names (`project.dataset.table.col`) keep their qualification, and
  quoted aliases are copied verbatim.

## 0.3.33 - 2026-08-02

- Treats `DISTRIBUTE` as a clause end so a trailing `GROUP BY` ordinal still
  resolves, and breaks `DISTRIBUTE RANDOM` onto its own line.

## 0.3.32 - 2026-08-02

- Moves a comma that the formatter placed on its own line back before a
  trailing line comment (e.g. `order_id --テキスト` followed by a lone `,`).

## 0.3.31 - 2026-08-02

- Fixes ordinal replacement for SQL that begins with an f-string field
  (e.g. `{write_clause}` before `SELECT`), and moves a field that ends the
  formatted SQL onto its own line (e.g. `{distribution_clause}` after
  `GROUP BY`).

## 0.3.30 - 2026-08-02

- Fixes f-string fields attached to identifiers (e.g. `id_{table_id}`) gaining
  a space when formatted: field markers are now bare identifiers instead of
  quoted strings, so the formatter keeps them joined.

## 0.3.29 - 2026-08-02

- Fixes ordinal replacement corrupting `SELECT *` queries: a star column is
  never copied into GROUP BY / ORDER BY, and commas are tokenized separately
  so columns like `*, a` are not merged into one expression.

## 0.3.28 - 2026-08-02

- Replaces `GROUP BY` / `ORDER BY` ordinal numbers with the referenced column
  names when formatting (alias preferred, expression otherwise). Disable with
  `inlineSql.format.replaceOrdinals: false`. Aggregate columns without an
  alias and unresolvable ordinals are left untouched.

## 0.3.27 - 2026-08-02

- Switches SQL highlighting to an injected TextMate grammar (the same
  approach as `inline-sql-syntax`), replacing the semantic tokens provider.
  SQL strings starting with `-- sql` or a leading SQL keyword are embedded
  as `meta.embedded.sql` and colored with the theme's SQL rules in both
  plain files and notebook cells. If a language server's semantic tokens
  override the grammar, disable semantic highlighting for that server.

## 0.3.26 - 2026-08-02

- Drops the fixed colors for `inlineSqlIdentifier` and `inlineSqlOperator`
  so columns and operators use the theme's base color and stand out from
  SQL keywords.

## 0.3.25 - 2026-08-02

- Provides default colors for the `inlineSql*` semantic token types so
  highlighting stays consistent on themes that do not define them.

## 0.3.24 - 2026-08-02

- Returns every semantic token from the range provider instead of clipping
  to the visible range, so notebook cells no longer show blank (unstyled)
  gaps for off-screen SQL tokens.

## 0.3.23 - 2026-08-02

- Adds an `Inline SQL Toolkit: Debug Semantic Tokens` command that dumps the
  active cell's language, text, and SQL tokens to the output panel.

## 0.3.22 - 2026-08-02

- Splits the semantic tokens providers: full-document tokens for notebook
  cells only, range tokens for plain Python files only, so the two never
  merge and cells render a stable token stream.

## 0.3.21 - 2026-08-02

- Provides full-document semantic tokens for every notebook cell so focused
  and unfocused cells render the same token stream instead of mixing ours
  with Pylance's or marimo-lsp's tokens.

## 0.3.20 - 2026-08-02

- Adds semantic tokens for marimo SQL cells, whose language id is `sql`, so
  they keep the SQL highlights instead of the marimo-lsp token stream.

## 0.3.19 - 2026-08-02

- Scopes full-document semantic tokens to the `mo-python` cell language so
  they reach marimo cells regardless of the notebook type.

## 0.3.18 - 2026-08-02

- Re-registers semantic tokens while any notebook is open (not only marimo),
  and extends the re-registration window to 60 seconds for slow first starts.

## 0.3.17 - 2026-08-02

- Re-registers semantic tokens only while a marimo notebook is open, and
  re-registers immediately whenever one opens, instead of on a fixed timer.

## 0.3.16 - 2026-08-02

- Aligns the closing triple-quote of a formatted literal with its base indent
  (e.g. inside loops) instead of leaving it at the left edge.

## 0.3.15 - 2026-08-02

- Indents the first SQL line too when a triple-quoted literal has no `--sql`
  marker, so a leading `SELECT` lines up with the rest of the query.

## 0.3.14 - 2026-08-02

- Restricts full-document semantic tokens to notebook cells so plain Python
  files keep using Pylance's tokens (fixes blank highlighting on Windows).

## 0.3.13 - 2026-08-02

- Re-registers the semantic tokens provider on a timer after activation so it
  stays the most recent provider once marimo-lsp finishes starting up.

## 0.3.12 - 2026-08-02

- Provides semantic tokens as a full-document provider and registers after
  the marimo extension activates, so notebook cells keep the SQL highlights
  instead of falling back to another provider's tokens.

## 0.3.11 - 2026-08-02

- Unifies the `--sql` marker position: markers on their own line move to sit
  directly after the opening quote, and SQL indents from the literal's line.

## 0.3.10 - 2026-08-02

- Indents SQL body one level below the literal's base indent, keeping nested
  lines one level deeper than `SELECT` for readable paragraph formatting.

## 0.2.5 - 2026-08-01

- Removes dark square background box for a 100% transparent background logo icon.

## 0.2.4 - 2026-08-01

- Fixes white corner artifacts in icon PNG by rendering a full-tile dark background with Playwright Chrome.

## 0.2.3 - 2026-08-01

- Fixes SVG comment syntax error (`--`) that caused XML rendering error text in icon PNG.

## 0.3.9 - 2026-08-01

- Indents SQL one level even when the `--sql` marker sits directly after the
  opening quote, so f-string and plain literals format consistently.

## 0.3.8 - 2026-08-01

- Keeps a `--sql` marker adjacent to the opening quote (`"""--sql`) on its
  own line so SQL indentation is preserved.

## 0.3.7 - 2026-08-01

- Indents formatted SQL one level below the `--sql` marker line so SQL lines
  are clearly nested under the surrounding Python code.

## 0.3.6 - 2026-08-01

- Keeps CRLF frame boundaries idempotent so formatting does not add blank
  lines above `--sql` markers on Windows.

## 0.3.5 - 2026-08-01

- Preserves the base indentation of indented SQL literals so formatted SQL
  stays aligned with the surrounding Python code.

## 0.3.4 - 2026-08-01

- Formats every code cell when `inlineSql.formatAll` runs in a notebook; the
  cursor commands keep formatting only the active cell.

## 0.3.3 - 2026-08-01

- Restores the original TextMate grammar selector and semantic token tests;
  highlighting is handled solely by semantic tokens that also cover Python.

## 0.3.2 - 2026-08-01

- Provides Python semantic tokens alongside SQL tokens so the extension
  replaces the Python language server's tokens without disabling semantic
  highlighting.

## 0.3.1 - 2026-08-01

- Switches SQL highlighting from semantic tokens to TextMate grammar injection
  so it cannot be overwritten by the Python language server.

## 0.3.0 - 2026-08-01

- Registers the SQL semantic token provider after Pylance activates so SQL
  highlighting stays visible instead of being overwritten by the Python
  language server.

## 0.2.9 - 2026-08-01

- Fixes false concatenation detection: comment separators and Python code
  between string literals no longer mark SQL candidates as unsupported.

## 0.2.8 - 2026-08-01

- Reports skip reasons (e.g. FORMATTER_FAILED) in the formatting summary so
  skipped candidates are diagnosable.

## 0.2.7 - 2026-08-01

- Registers only the range semantic tokens provider so SQL highlighting is
  not overwritten by the Python language server.

## 0.2.6 - 2026-08-01

- Registers semantic tokens as a range provider so SQL highlighting wins over
  the Python language server without disabling semantic highlighting.

## 0.2.2 - 2026-08-01

- Updates extension icon to a clean, minimalist developer logo without Python branding or AI effects.

## 0.3.9 - 2026-08-01

- Indents SQL one level even when the `--sql` marker sits directly after the
  opening quote, so f-string and plain literals format consistently.

## 0.3.8 - 2026-08-01

- Keeps a `--sql` marker adjacent to the opening quote (`"""--sql`) on its
  own line so SQL indentation is preserved.

## 0.3.7 - 2026-08-01

- Indents formatted SQL one level below the `--sql` marker line so SQL lines
  are clearly nested under the surrounding Python code.

## 0.3.6 - 2026-08-01

- Keeps CRLF frame boundaries idempotent so formatting does not add blank
  lines above `--sql` markers on Windows.

## 0.3.5 - 2026-08-01

- Preserves the base indentation of indented SQL literals so formatted SQL
  stays aligned with the surrounding Python code.

## 0.3.4 - 2026-08-01

- Formats every code cell when `inlineSql.formatAll` runs in a notebook; the
  cursor commands keep formatting only the active cell.

## 0.3.3 - 2026-08-01

- Restores the original TextMate grammar selector and semantic token tests;
  highlighting is handled solely by semantic tokens that also cover Python.

## 0.3.2 - 2026-08-01

- Provides Python semantic tokens alongside SQL tokens so the extension
  replaces the Python language server's tokens without disabling semantic
  highlighting.

## 0.3.1 - 2026-08-01

- Switches SQL highlighting from semantic tokens to TextMate grammar injection
  so it cannot be overwritten by the Python language server.

## 0.3.0 - 2026-08-01

- Registers the SQL semantic token provider after Pylance activates so SQL
  highlighting stays visible instead of being overwritten by the Python
  language server.

## 0.2.9 - 2026-08-01

- Fixes false concatenation detection: comment separators and Python code
  between string literals no longer mark SQL candidates as unsupported.

## 0.2.8 - 2026-08-01

- Reports skip reasons (e.g. FORMATTER_FAILED) in the formatting summary so
  skipped candidates are diagnosable.

## 0.2.7 - 2026-08-01

- Registers only the range semantic tokens provider so SQL highlighting is
  not overwritten by the Python language server.

## 0.2.6 - 2026-08-01

- Registers semantic tokens as a range provider so SQL highlighting wins over
  the Python language server without disabling semantic highlighting.

## 0.2.2 - 2026-08-01

- Registers semantic tokens as a range provider so SQL highlighting wins over
  the Python language server without disabling semantic highlighting.

## 0.2.1 - 2026-08-01

- Normalizes triple-quoted frame boundaries so the opening and closing `"""`
  stay on their own lines.
- Protects escaped brace pairs (`{{...}}`) as one fragment so their spacing
  survives formatting.

## 0.2.0 - 2026-08-01

- Switches the formatter engine from `sqlparse` to the bundled `sql-formatter`
  (JS), which lays out nested function calls and long expressions correctly.
- Adds `inlineSql.format.dialect` (default `postgresql`; `sql`, `mysql`, and
  `sqlite` also supported) for dialect-aware formatting.
- Adds `inlineSql.format.trimBlankBoundaries` (default `true`) to collapse
  extra blank lines at the start and end of triple-quoted SQL to a single line
  ending.
- Ports the entire analysis pipeline (detection, protection, restore,
  validation, and target selection) from the Python helper to TypeScript and
  removes the Python runtime, bundled `sqlparse`, `inlineSql.pythonPath`, and
  the helper bootstrap. The VSIX drops from ~58 to 16 files.

## 0.1.1 - 2026-08-01

- Adds official extension icon for VS Code Marketplace and Open VSX listings.

## 0.1.0 - 2026-08-01

- Highlights SQL embedded in supported Python strings and in Jupyter and
  marimo Python cells.
- Provides the manual commands `Format at Cursor`, `Format Selection`, and
  `Format All`; it does not register format-on-save or another formatter
  provider.
- Formats with the bundled, offline `sqlparse` 0.5.5 engine without executing
  or validating SQL or inferring a dialect.
- Preserves Python source and f-string replacement fields, skips unsafe or
  unsupported literal shapes, and shows highlighting only in untrusted
  workspaces.
- Includes the project MIT license and third-party sqlparse BSD-3-Clause and
  Microsoft Python Extension API facade MIT notices.
- Adds SQL semantic tokens so the SQL portion keeps its highlighting even when
  a Python language server classifies the whole f-string as a string token.
- Disables `editor.semanticHighlighting.enabled` for Python and Marimo Python
  by default; Python language servers would otherwise override the SQL
  highlighting contributed by the TextMate grammar.
- Adds `inlineSql.format.expandSelectList` (default `true`) to place every
  SELECT column on its own indented line in triple-quoted SQL.
- Formats f-string fields that appear inside SQL string literals, for example
  `WHERE status = '{value}'`.
