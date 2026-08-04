# Changelog

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
