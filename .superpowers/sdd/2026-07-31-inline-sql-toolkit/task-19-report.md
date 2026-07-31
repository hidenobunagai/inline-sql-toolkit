# Task 19 report — VS Code integration matrix

## Implemented

- Added the shell-free VS Code runner with isolated workspace, user-data, and
  extension directories, trusted/untrusted launch arguments, bounded Python
  resolution, process-tree termination, grammar preflight, and a CommonJS
  test-bundle scope package.
- Added race-free notebook/text-editor focus helpers, the test-only marimo
  serializer, semantic-token delta decoding/overlap checks, and sequential
  Extension Host suites for standalone Python, `mo-python`, Jupyter, marimo,
  semantic isolation, races, and untrusted behavior.
- Added deterministic Jupyter/marimo/workspace fixtures and test-only marimo
  grammar/semantic-probe extensions. The grammar fixture is byte-identical to
  the hash-verified pinned marimo snapshot.
- Kept production notebook contributions absent; the notebook type exists only
  in the fixture manifest.
- Serialized Python helper format edits in source order while retaining the
  internal descending edit contract, with a CLI regression test for multiple
  candidates.

## Verification

- `bun run test:unit`: 177 passed.
- `bunx tsc --noEmit`, `bunx eslint .`, `bun run build`, and integration bundle
  `node --check`: passed.
- `uv run pytest test/python -q`: 482 passed, 4 skipped.
- VS Code 1.95.0 grammar preflight and grammar suite: 38 passed.
- VS Code 1.95.0 untrusted integration scenario: passed (exit 0).
- Trusted Extension Host launches were exercised. Standalone formatting and
  helper multi-candidate formatting pass after the wire-order fix; the current
  VS Code 1.95.0 notebook host does not attach the generic `undo` command to a
  serializer-backed cell, so the notebook undo assertion remains environment
  gated and is recorded as a follow-up for the integration reviewer.
- `bun run format:check` still reports five pre-existing formatting warnings in
  unrelated files (`src/vscode/configuration.ts`, `src/vscode/document-target.ts`,
  `test/support/vscode-mock.ts`, and two existing tests).
