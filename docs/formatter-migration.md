# Formatter migration design: sqlparse to sql-formatter

Status: draft for review

## 1. Background and motivation

The current formatter, vendored `sqlparse`, tokenizes SQL without building an
AST. When a line exceeds `wrapAfter`, sqlparse breaks it at token boundaries
without understanding nesting, which produces broken indentation for nested
function calls such as:

```sql
(julianday(substr(MAX(ord_date_key), 1, 4) || '-' || substr(...)) - julianday(...)) AS recency
```

Reproduction confirmed both from already-wrapped input and from a single-line
input: sqlparse cannot lay out nested expressions correctly.

## 2. Evaluated alternatives

| Option                 | Nesting layout        | Identifier/function preservation     | Dependencies                     | Verdict                                                 |
| ---------------------- | --------------------- | ------------------------------------ | -------------------------------- | ------------------------------------------------------- |
| sqlparse (current)     | broken                | preserved                            | 1 vendored package               | keep as fallback only                                   |
| SQLFluff               | clean                 | preserved                            | 15+ packages (jinja, click, ...) | rejected: vendoring and offline runtime are impractical |
| sqlglot                | no wrap (single line) | **rewrites `substr` to `SUBSTRING`** | none                             | rejected: changes SQL meaning                           |
| **sql-formatter (JS)** | **clean**             | **preserved**                        | small, JS                        | **selected**                                            |

sql-formatter verification results:

- Nested `julianday(substr(...))` layouts cleanly with aligned closing
  parentheses.
- Identifiers, function names, and quoted markers are preserved.
- `{...}` passed directly is a parse error; the existing protection mechanism
  (replace `{...}` with a marker before formatting) remains mandatory.
- Quoted markers (`"__INLINE_SQL_<nonce>_FIELD_1__"`) are preserved.
- `lineWidth` controls wrapping; the output differs by dialect (for example
  `julianday (a)` in postgresql vs `julianday(a)` in sqlite).

## 3. Target architecture

Current:

```
TS extension -> Python helper process -> sqlparse
```

Python helper responsibilities: literal analysis (SQL candidate detection),
protection (f-string `{...}` -> marker), formatting, restore (marker ->
`{...}`), and idempotency validation.

Target (proposed): move formatting into the TS extension using sql-formatter
bundled with esbuild. The Python helper keeps detection, protection, restore,
and validation. Data flow becomes:

```
TS: document -> Python (detect + protect) -> protected SQL
TS: protected SQL -> sql-formatter (bundled) -> formatted SQL
TS: formatted SQL -> Python (restore + validate) -> edits
```

This keeps the Python helper's accurate AST-based literal analysis while
replacing only the formatting step. The extension host is already running, so
sql-formatter executes without spawning a new process.

Trade-off: the Python helper round-trips twice per format instead of once.
Measured process startup is ~100-200 ms per invocation; acceptable for a
manual format command. If unacceptable, Phase 3 below removes the helper
entirely.

## 4. Dialect handling

- New setting `inlineSql.format.dialect` (string, default `postgresql`).
  User reports PostgreSQL as the primary dialect, SQLite second.
- Passed to sql-formatter's `language` option. Supported values follow
  sql-formatter: `sql`, `mysql`, `postgresql`, `sqlite`, and others.
- Dialect-specific output differences (for example function-call spacing)
  are documented behavior, not defects.

## 5. Protection mechanism changes

- Marker text changes from `__INLINE_SQL_<nonce>_FIELD_1__` to
  `"__INLINE_SQL_<nonce>_FIELD_1__"` (double-quoted identifier).
- sql-formatter preserves quoted identifiers; unquoted identifiers are
  normalized (upper-cased), which would break marker restore.
- The restore step keeps searching for the exact quoted marker text.
- `{...}` remains protected before formatting (direct input is a parse error).

## 6. Feature parity to preserve

- SQL candidate detection and `-- sql` / keyword classification.
- f-string `{...}` protection and restore (including nested fields).
- Idempotency validation (`_validate_replacement_and_idempotency`).
- Untrusted-workspace gating.
- `expandSelectList`: sql-formatter has no select-list expansion; keep the
  existing post-processing in the helper.
- `trimBlankBoundaries`: keep the existing frame normalization.
- Options mapping: `keywordCase` -> sql-formatter `keywordCase`;
  `indentWidth` -> `tabWidth`; `wrapAfter` -> `lineWidth`;
  `useSpaceAroundOperators` -> `useTabs`/spacing options.

## 7. Risks and mitigations

| Risk                                                                           | Mitigation                                                                                                |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| sql-formatter cannot parse some SQL that sqlparse accepted                     | parse failure returns a stable skip reason (FORMATTER_FAILED), same as today; golden fixtures per dialect |
| Marker restore breaks if sql-formatter reorders or rewrites quoted identifiers | idempotency validation re-parses and compares field texts; restore rejects moved markers                  |
| Twice the helper round-trips slows formatting                                  | manual command only; benchmark and revisit in Phase 3                                                     |
| sql-formatter bundle size grows the VSIX                                       | measure; sql-formatter is small (a few hundred KB)                                                        |

## 8. Migration phases

- Phase 0 (done): alternative evaluation and sql-formatter verification.
- Phase 1: add `inlineSql.format.dialect`; wire sql-formatter into the TS
  extension; keep Python helper for detection/protection/restore/validation.
- Phase 2: port golden fixtures (`format-cases.json`) and add dialect-specific
  fixtures; update integration tests.
- Phase 3 (optional, later): port literal analysis to TS and remove the Python
  helper, if the round-trip cost is unacceptable.

## 9. Testing plan

- Golden fixtures per dialect (postgresql, sqlite) covering nesting, wrapping,
  `{...}` protection, quoted markers, `expandSelectList`,
  `trimBlankBoundaries`.
- Idempotency tests (format twice, identical output).
- Integration tests: format command end-to-end with a bundled sql-formatter.
- VSIX verification: sql-formatter files must be in the bundle allowlist.
