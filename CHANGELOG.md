# Changelog

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
