# Changelog

## 0.2.5 - 2026-08-01

- Removes dark square background box for a 100% transparent background logo icon.

## 0.2.4 - 2026-08-01

- Fixes white corner artifacts in icon PNG by rendering a full-tile dark background with Playwright Chrome.

## 0.2.3 - 2026-08-01

- Fixes SVG comment syntax error (`--`) that caused XML rendering error text in icon PNG.

## 0.2.6 - 2026-08-01

- Registers semantic tokens as a range provider so SQL highlighting wins over
  the Python language server without disabling semantic highlighting.

## 0.2.2 - 2026-08-01

- Updates extension icon to a clean, minimalist developer logo without Python branding or AI effects.

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
