# Changelog

## Unreleased

- Switches the formatter engine from `sqlparse` to the bundled `sql-formatter`
  (JS), which lays out nested function calls and long expressions correctly.
- Adds `inlineSql.format.dialect` (default `postgresql`; `sql`, `mysql`, and
  `sqlite` also supported) for dialect-aware formatting.
- Adds `inlineSql.format.trimBlankBoundaries` (default `true`) to collapse
  extra blank lines at the start and end of triple-quoted SQL to a single line
  ending.

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
