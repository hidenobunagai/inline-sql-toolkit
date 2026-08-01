# Inline SQL Toolkit

Inline SQL Toolkit highlights SQL embedded in Python strings and formats selected
SQL with the bundled `sql-formatter` layout engine. It supports ordinary `.py`
files, marimo
(`.mo.py`) programs, and Python cells in Jupyter notebooks. In marimo notebooks
the `python` and `mo-python` cell languages are supported. SQL-language cells
and notebook magic commands (`%sql`, `%%sql`, and similar magic syntax) are not
supported.

Requirements are VS Code 1.95 or newer and Python 3.12 or newer. Formatting is
manual-only: this extension does not register a formatter provider, format on
save, format on type, or format ranges automatically. It never executes SQL,
validates SQL, infers a SQL dialect, connects to a database, or sends source to
the network. The formatter is best-effort; an unsafe candidate is skipped while
other safe candidates may still be edited.

In short, SQL is never executed by this extension. SQL is never validated by
this extension.

## Quick start

Open a supported Python document or notebook cell, place the cursor in one of
the examples below, and choose a command from the Command Palette.

### Plain string

```python
query = "SELECT id, name FROM users WHERE active = true"
```

### Marker triple-quoted string

```python
query = """
-- sql
select id, name
from users
where active = true
"""
```

### Complex f-string

```python
account_id = get_account_id()
query = f"""
-- sql
SELECT id, name
FROM users
WHERE account_id = {account_id}
  AND status = {{'active'}}
"""
```

The f-string example demonstrates that Python replacement fields and escaped
braces remain Python source. Only the SQL portions are considered for layout;
the extension preserves the original f-string expressions and escapes.

## Commands

The command IDs are shown for keybindings and automation integrations:

- **Inline SQL: Format at Cursor** (`inlineSql.formatAtCursor`) formats the SQL
  candidate containing the cursor.
- **Inline SQL: Format Selection** (`inlineSql.formatSelection`) formats SQL
  candidates intersecting the current selection.
- **Inline SQL: Format All** (`inlineSql.formatAll`) formats every detected
  candidate in the current document or notebook cell.

Each invocation checks the document version and the expected source text before
creating one `WorkspaceEdit`, so the operation is one undo step. VS Code does
not provide an atomic, versioned precondition for an edit that happens after
that check. Changes observed before the edit are rejected as stale; a change
that races after the check can still be applied because VS Code provides no
later atomic precondition.

## Settings

- `inlineSql.format.keywordCase`: `upper` (default), `lower`, or `preserve`.
- `inlineSql.format.indentWidth`: SQL indentation width from 1 to 8 spaces
  (default 2).
- `inlineSql.format.wrapAfter`: preferred line width from 20 to 500 (default
  88).
- `inlineSql.format.useSpaceAroundOperators`: add spaces around operators
  (default `true`).
- `inlineSql.format.expandSelectList`: place every SELECT column on its own
  indented line in triple-quoted SQL (default `true`).
- `inlineSql.format.trimBlankBoundaries`: collapse extra blank lines at the
  start and end of triple-quoted SQL to a single line ending (default `true`).
- `inlineSql.format.dialect`: SQL dialect used by the formatter (`sql`,
  `mysql`, `postgresql`, or `sqlite`; default `postgresql`).
- `inlineSql.pythonPath`: optional absolute path to a Python 3.12+ interpreter.
  The path is read only in a trusted workspace; invalid or non-string values
  are rejected. VS Code marks this setting restricted in untrusted workspaces,
  but the extension does not claim to validate path containment.

For Python and Marimo Python documents the extension disables
`editor.semanticHighlighting.enabled` by default. Python language servers
(such as Pylance) classify an entire f-string as a string token, which would
override the SQL highlighting contributed by this extension. Users who enable
semantic highlighting for Python in their own settings override this default;
the extension then also contributes its own SQL semantic tokens.

## Detection and supported syntax

Formatter detection is source-level: it examines Python tokens and the literal
characters in the source, rather than evaluating the string value. A candidate
is found when either condition holds:

1. The first logical, non-blank line starts with `-- sql` or `--sql` after
   horizontal whitespace. Matching is case-insensitive and the marker text is
   preserved.
2. After removing only physically present ASCII space, tab, CR, and LF
   characters, the source starts with one of `SELECT`, `WITH`, `INSERT`,
   `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, or
   `EXPLAIN`, followed by a word boundary. The two source characters `\n` are
   not treated as whitespace.

Standalone plain and raw strings, f-strings, and raw f-strings (`f`, `rf`, and
`fr`, in either case) are supported with single, double, and triple delimiters
(`'`, `"`, `'''`, and `"""`). A parseable candidate in a supported literal is
also the candidate used by the syntax highlighting grammar.

The following are intentionally skipped: bytes and byte strings (`b`/`rb`),
implicit or explicit string concatenation, t-strings, invalid Python, dynamic
or non-literal SQL, and SQL-language cells. A candidate that cannot be restored
without changing Python source is reported as unsafe and is not edited.

## Trust, privacy, and offline behavior

In an untrusted workspace the extension provides highlighting only. The three
formatting commands remain visible, but formatting is disabled: no Python
process starts, no Code Actions are offered, and no edits are applied until
the workspace is trusted. In a trusted workspace the helper is launched with a
fixed isolated command and receives only the protocol request on standard
input. SQL is not written to disk, logged, telemetered, sent over the network,
passed to a shell/database, or executed. The bundled `sql-formatter` and
`sqlparse` code runs offline and is a layout engine, not a SQL validator.

## Troubleshooting

- **No candidate found:** confirm the source uses a supported literal and that
  the first logical line has `-- sql`/`--sql`, or that a listed keyword is at
  the source-level start with a word boundary.
- **Unsupported literal or unsafe f-string:** remove concatenation, bytes or
  t-string syntax, and verify that Python parses the document. Complex f-string
  expressions are skipped when their source spans cannot be restored exactly.
- **Formatting is unavailable:** use a trusted workspace and a Python 3.12+
  interpreter. Check `inlineSql.pythonPath` and the diagnostic reason shown by
  the extension (`PYTHON_NOT_FOUND`, `PYTHON_VERSION_UNSUPPORTED`,
  `WORKSPACE_UNTRUSTED`, `INVALID_CONFIGURATION`, or `PROCESS_TIMEOUT`).
- **SQL looks different than expected:** formatting does not validate SQL or
  infer a dialect. Adjust the settings above and review the source-level
  candidate before applying the one-step edit.

For security reporting, see [SECURITY.md](SECURITY.md). For source-free bug
reports and diagnostic reason codes, see [SUPPORT.md](SUPPORT.md). Licensing and
component provenance are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
