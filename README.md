# Inline SQL Toolkit

Inline SQL Toolkit highlights SQL embedded in Python strings and formats selected
SQL with the bundled `sqlparse` engine. It supports regular Python files, marimo
(`.mo.py`) programs, and Python cells in Jupyter notebooks.

Requirements: VS Code 1.95 or newer and Python 3.12 or newer. Formatting is
manual-only and never runs on save. Formatting is best-effort and does not
validate SQL or connect to a database. The extension uses no network, database,
or telemetry services.

## Commands

- **Inline SQL: Format at Cursor** formats the SQL candidate containing the cursor.
- **Inline SQL: Format Selection** formats candidates intersecting the selection.
- **Inline SQL: Format All** formats every detected candidate in the document/cell.

Use the Command Palette. Each command supports one undo operation for the edits
it applies.

## Settings

- `inlineSql.format.keywordCase`: `upper` (default), `lower`, or `preserve`.
- `inlineSql.format.indentWidth`: indentation width from 1 to 8 (default 2).
- `inlineSql.format.wrapAfter`: preferred line width from 20 to 500 (default 88).
- `inlineSql.format.useSpaceAroundOperators`: add spaces around operators (default true).
- `inlineSql.pythonPath`: optional absolute Python 3.12+ interpreter path.

In an untrusted workspace the extension provides highlighting only. It does not
start Python or expose formatting actions until the workspace is trusted.

## Limitations

SQL strings must be statically discoverable in Python source. Dynamic SQL and
database-specific validation are outside the scope of this extension. Formatting
is performed only when a user invokes one of the commands.
