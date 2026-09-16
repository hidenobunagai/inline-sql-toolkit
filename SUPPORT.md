# Support

Use a repository issue for usage questions and reproducible, non-sensitive
bugs. This project has no guaranteed response time. Do not include SQL source,
credentials, tokens, customer data, private paths, or other secrets. Reports
should be source-free: describe the literal shape (for example, plain,
triple-quoted, or f-string), operation, document/cell kind, and redacted
settings instead of pasting a query.

Include these diagnostic details when available:

- Inline SQL Toolkit version (for example, `0.1.0`), VS Code version, and
  operating system.
- Whether the workspace is trusted, and whether the target is a `.py`, Jupyter
  Python cell, or marimo `python`/`mo-python` cell.
- The command (`inlineSql.formatAtCursor`, `inlineSql.formatSelection`, or
  `inlineSql.formatAll`), whether the cursor/selection was involved, and the
  relevant non-sensitive setting names and values.
- The diagnostic reason code shown by the extension. Never include document
  contents merely to provide a reason code.

## Diagnostic reason codes

| Code                      | Meaning                                                 |
| ------------------------- | ------------------------------------------------------- |
| `WORKSPACE_UNTRUSTED`     | Formatting is disabled until trust is granted.          |
| `INVALID_CONFIGURATION`   | An `inlineSql.format.*` setting has an invalid value.   |
| `NO_SQL_CANDIDATE`        | No supported source-level SQL candidate was found.      |
| `UNSUPPORTED_LITERAL`     | The literal shape is outside the supported scope.       |
| `UNSAFE_FSTRING_RESTORE`  | An f-string could not be restored byte-for-byte safely. |
| `UNSAFE_RAW_STRING`       | A raw-string edit could not preserve its source safely. |
| `FORMATTER_FAILED`        | The bundled formatter could not produce a safe result.  |
| `RESOURCE_LIMIT_EXCEEDED` | A document, candidate, or request exceeded a guard.     |
| `PROCESS_CANCELLED`       | The formatting request was cancelled.                   |
| `PROCESS_FAILED`          | Formatting failed unexpectedly.                         |
| `DOCUMENT_CHANGED`        | The document changed before the guarded edit.           |
| `APPLY_EDIT_FAILED`       | VS Code rejected the guarded workspace edit.            |
| `PROTOCOL_ERROR`          | The result failed an internal consistency check.        |

Inline SQL Toolkit does not provide database connectivity, SQL validation,
network services, or telemetry. A support report should therefore focus on the
source shape, operation, versions, trust state, and reason code rather than a
database or remote service.
