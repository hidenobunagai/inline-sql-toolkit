# Inline SQL Toolkit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Python文字列内のSQLをTextMateでハイライトし、Pythonのf-string構文を原文のまま
保護しながら、同梱した`sqlparse` 0.5.5で安全に手動整形できるVS Code拡張機能を作る。
通常のPython document、JupyterのPython cell、marimoの`python`・`mo-python` cellを
同じ規則で扱う。

**Architecture:** 表示はPythonと`mo-python`へ注入する2層のTextMate grammar、操作と
Notebook連携はTypeScript製VS Code extension、解析と整形はPython 3.12以上で動く
ワンショットhelperへ分離する。TypeScriptとPythonは厳密なversion付きJSON protocolで
接続し、helperはAST、`tokenize`、source span、不変条件検証を通過したeditだけを返す。

**Tech Stack:** VS Code Extension API 1.95、TypeScript 5.9、Bun 1.3.8、esbuild、
Vitest、`vscode-textmate`、`vscode-oniguruma`、Python 3.12–3.14、uv 0.9.28、pytest、
Hypothesis、Ruff、ty、vendored `sqlparse` 0.5.5、GitHub Actions、OSV-Scanner。

## Global Constraints

- 実装前に
  [承認済み設計](../specs/2026-07-30-inline-sql-toolkit-design.md)を読み直す。
- 各taskでは`superpowers:test-driven-development`を使い、記載された失敗testを先に
  実行して、期待した理由で失敗することを確認してからproduction codeを書く。
- Task 1のTextMate実現性ゲートはhard stopである。VS Code 1.95.0とstableのどちらかで
  PEP 701受け入れcaseが1件でも失敗した場合、Task 2以降へ進まない。要件縮小、
  semantic token、Python grammar forkのいずれも自動選択せず、設計レビューへ戻る。
- `.py`、Jupyter、marimo、f-string安全性は初回リリース境界であり、後続版へ分割しない。
- Python formatter、range formatter、format-on-save、format-on-typeを登録しない。
- SQLを実行しない。database、network、shellへsourceを渡さない。telemetryを追加しない。
- document本文をdiskへ書かない。sourceをprotocol payload以外のstdout、stderr、log、
  notificationへ出さない。
- untrusted workspaceでは宣言的なgrammarだけを有効にし、version確認を含むprocess起動、
  Code Action、editを無効化する。
- TypeScript sourceはstrict ESM、extension bundleだけをNode 20向けCommonJSにする。
  `any`、型のないJSON access、shell command文字列を使用しない。
- Pythonは3.12以上、完全なtype hint、Ruff、ty、pytestを必須とし、runtimeでは
  user site packageと`PYTHONPATH`を参照しない。
- package managerはBun 1.3.8、Python environment managerはuv 0.9.28とする。
  lockfileをcommitし、CIでは同じtool versionによるfrozen installだけを行う。
- 既存の`.DS_Store`は利用者のuntracked fileとして扱い、変更、stage、削除しない。
- taskごとに記載されたtestを通し、そのtaskのfileだけをstageしてcommitする。
- 完了を報告する前に`superpowers:verification-before-completion`を使い、clean checkout相当の
  install、全test、実VSIX検査を再実行する。

---

## 1. 固定する公開契約

### 1.1 Commandと設定

| Command ID | Title |
| --- | --- |
| `inlineSql.formatAtCursor` | `Inline SQL: Format at Cursor` |
| `inlineSql.formatSelection` | `Inline SQL: Format Selection` |
| `inlineSql.formatAll` | `Inline SQL: Format All in Document/Cell` |

| Setting | Type | Default | Validation |
| --- | --- | --- | --- |
| `inlineSql.format.keywordCase` | `upper \| lower \| preserve` | `upper` | enum |
| `inlineSql.format.indentWidth` | integer | `2` | 1–8 |
| `inlineSql.format.wrapAfter` | integer | `88` | 20–500 |
| `inlineSql.format.useSpaceAroundOperators` | boolean | `true` | boolean |
| `inlineSql.pythonPath` | string | empty | resource、restricted |

Code Actionは`Format inline SQL`、kindは`refactor.rewrite`とする。既定shortcut、
status bar item、document formatting providerは設けない。

### 1.2 SQL検出

- 最初の論理行が、source上の水平空白を除いて`-- sql`または`--sql`と一致する。
  比較はcase-insensitiveで、marker原文を保持する。
- または、source上で物理的に書かれたASCII space、tab、CR、LFを除いた先頭が
  `SELECT`、`WITH`、`INSERT`、`UPDATE`、`DELETE`、`MERGE`、`CREATE`、`ALTER`、
  `DROP`、`TRUNCATE`、`EXPLAIN`のいずれかで、直後にword boundaryがある。
- `\n`の2文字を空白として評価しない。検出は常時有効で、無効化設定を作らない。
- formatterが候補としたparse可能なliteralは、grammarでも必ずSQL scopeを持つ。

### 1.3 Resourceとprocess上限

| Guard | Limit |
| --- | --- |
| document/cell UTF-8 size | 5 MiB |
| candidate literal UTF-8 size | 1 MiB |
| candidates per request | 1,000 |
| helper hard timeout | 5 seconds |
| helper stdin JSON | 32 MiB |
| helper stdout JSON | 64 MiB |
| helper stderr capture | 64 KiB |

helper起動argumentは固定して次の形にする。

```text
<python> -I -S -B -X utf8 <extension>/python/bootstrap.py
```

### 1.4 Stable reason code

```text
PYTHON_NOT_FOUND
PYTHON_VERSION_UNSUPPORTED
WORKSPACE_UNTRUSTED
INVALID_CONFIGURATION
DOCUMENT_PARSE_FAILED
NO_SQL_CANDIDATE
UNSUPPORTED_LITERAL
UNSAFE_FSTRING_RESTORE
UNSAFE_RAW_STRING
FORMATTER_FAILED
RESOURCE_LIMIT_EXCEEDED
PROCESS_TIMEOUT
PROCESS_CANCELLED
PROCESS_FAILED
DOCUMENT_CHANGED
APPLY_EDIT_FAILED
PROTOCOL_ERROR
```

候補単位のskipは安全なeditと同居できる。request単位のerrorはeditを一件も持たない。

## 2. Dependency Baseline

`package.json`ではexact versionを使い、range記号を付けない。

```json
{
  "packageManager": "bun@1.3.8",
  "dependencies": {
    "@vscode/python-extension": "1.0.5"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "@types/node": "20.19.43",
    "@types/vscode": "1.95.0",
    "@vscode/test-electron": "2.5.2",
    "@vscode/vsce": "3.9.2",
    "@vitest/coverage-v8": "4.1.10",
    "esbuild": "0.28.0",
    "eslint": "10.7.0",
    "eslint-plugin-simple-import-sort": "14.0.0",
    "eslint-plugin-unused-imports": "4.4.1",
    "fast-check": "4.9.0",
    "globals": "17.7.0",
    "prettier": "3.9.6",
    "typescript": "5.9.3",
    "typescript-eslint": "8.65.0",
    "vitest": "4.1.10",
    "vscode-oniguruma": "2.0.1",
    "vscode-textmate": "9.3.2",
    "yaml": "2.9.0"
  }
}
```

Bunとuvのtool version自体も`1.3.8`と`0.9.28`へ固定する。Task 21のすべての
`setup-bun` stepは`bun-version: "1.3.8"`、すべての`setup-uv` stepは
`version: "0.9.28"`を明記し、Task 22のprerequisitesも同じ値を記載する。

`@vscode/python-extension` 1.0.5はNode 16.17.1以上、VS Code 1.78以上を要求する。
1.0.6はNode 22.17以上を要求するため、VS Code 1.95 Extension Hostとの互換性を保つ目的で
1.0.5に固定する。開発時のNodeは22、生成bundleのtargetと検査runtimeはNode 20とする。

`bunfig.toml`は供給網の待機期間を固定する。

```toml
[install]
minimumReleaseAge = 604800
```

`pyproject.toml`の開発dependencyもexact pinにする。

```toml
[project]
name = "inline-sql-toolkit-helper"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = []

[dependency-groups]
dev = [
  "hypothesis==6.160.0",
  "pre-commit==4.6.1",
  "pytest==9.1.1",
  "pytest-cov==7.1.0",
  "ruff==0.15.22",
  "ty==0.0.61",
]

[tool.uv]
package = false
native-tls = true
```

`sqlparse`はruntime dependencyとして宣言せず、固定wheelから展開したvendor treeだけを
使用する。

```text
version=0.5.5
url=https://files.pythonhosted.org/packages/49/4b/359f28a903c13438ef59ebeee215fb25da53066db67b305c125f1c6d2a25/sqlparse-0.5.5-py3-none-any.whl
sha256=12a08b3bf3eec877c519589833aed092e2444e68240a3577e8e26148acc7b1ba
```

## 3. Target File Map

```text
.
├── .github/
│   └── workflows/
│       ├── ci.yml
│       ├── compatibility.yml
│       ├── osv-scanner-pr.yml
│       └── osv-scanner-scheduled.yml
├── .gitignore
├── .pre-commit-config.yaml
├── .prettierignore
├── .prettierrc.json
├── .vscodeignore
├── CHANGELOG.md
├── LICENSE
├── README.md
├── SECURITY.md
├── SUPPORT.md
├── THIRD_PARTY_NOTICES.md
├── bun.lock
├── bunfig.toml
├── docs/
│   ├── development.md
│   ├── releasing.md
│   └── superpowers/
│       ├── plans/
│       └── specs/
├── eslint.config.mjs
├── package.json
├── package.nls.ja.json
├── package.nls.json
├── protocol/
│   └── v1.schema.json
├── pyproject.toml
├── python/
│   ├── bootstrap.py
│   ├── inline_sql_helper/
│   │   ├── __init__.py
│   │   ├── candidate_formatter.py
│   │   ├── cli.py
│   │   ├── detection.py
│   │   ├── engine.py
│   │   ├── literals.py
│   │   ├── model.py
│   │   ├── positions.py
│   │   ├── protection.py
│   │   ├── protocol.py
│   │   ├── sqlparse_adapter.py
│   │   └── token_bundles.py
│   └── vendor/
│       └── sqlparse/
├── src/
│   ├── constants.ts
│   ├── extension.ts
│   ├── protocol.ts
│   └── vscode/
│       ├── code-actions.ts
│       ├── commands.ts
│       ├── configuration.ts
│       ├── document-target.ts
│       ├── edit-applicator.ts
│       ├── format-controller.ts
│       ├── helper-client.ts
│       ├── notifications.ts
│       ├── python-resolver.ts
│       └── test-hooks.ts
├── syntaxes/
│   ├── inline-sql-fstring-islands.tmLanguage.json
│   └── inline-sql-python.tmLanguage.json
├── test/
│   ├── fixtures/
│   │   ├── grammar-lock.json
│   │   ├── grammars/
│   │   │   ├── marimo-LICENSE
│   │   │   ├── marimo-SOURCE.json
│   │   │   └── marimo-python.tmLanguage.json
│   │   ├── helper/
│   │   │   ├── format-cases.json
│   │   │   ├── offline-request.json
│   │   │   └── protocol-cases.json
│   │   ├── extensions/
│   │   │   ├── marimo-language/
│   │   │   │   ├── package.json
│   │   │   │   └── syntaxes/
│   │   │   │       └── python.tmLanguage.json
│   │   │   ├── semantic-probe/
│   │   │   │   ├── extension.js
│   │   │   │   └── package.json
│   │   │   └── vsix-driver/
│   │   │       ├── extension.js
│   │   │       └── package.json
│   │   ├── notebooks/
│   │   │   ├── jupyter.ipynb
│   │   │   └── marimo.py
│   │   ├── pep701-grammar-cases.json
│   │   ├── sql-detection.json
│   │   └── workspaces/
│   │       ├── trusted/
│   │       └── untrusted/
│   ├── grammar/
│   │   ├── detection-parity.test.ts
│   │   └── feasibility-gate.test.ts
│   ├── integration/
│   │   ├── compatibility.test.ts
│   │   ├── extension.test.ts
│   │   ├── notebooks.test.ts
│   │   ├── run.ts
│   │   ├── semantic-tokens.test.ts
│   │   ├── untrusted.test.ts
│   │   └── vsix-smoke.test.ts
│   ├── python/
│   │   ├── test_bootstrap.py
│   │   ├── test_benchmark_helper.py
│   │   ├── test_candidate_formatter.py
│   │   ├── test_cli.py
│   │   ├── test_detection.py
│   │   ├── test_engine.py
│   │   ├── test_fstring_properties.py
│   │   ├── test_literals.py
│   │   ├── test_positions.py
│   │   ├── test_protection.py
│   │   ├── test_protocol.py
│   │   ├── test_sqlparse_adapter.py
│   │   ├── test_token_bundles.py
│   │   ├── test_vendor_sqlparse.py
│   │   └── test_vsix.py
│   ├── support/
│   │   ├── detection-parity.ts
│   │   ├── grammar-loader.ts
│   │   ├── helper-fixtures.ts
│   │   ├── integration-scenario.ts
│   │   ├── semantic-tokens.ts
│   │   ├── vscode-mock.ts
│   │   └── vscode-harness.ts
│   └── ts/
│       ├── code-actions.test.ts
│       ├── configuration.test.ts
│       ├── document-target.test.ts
│       ├── edit-applicator.test.ts
│       ├── format-controller.test.ts
│       ├── helper-client.test.ts
│       ├── install-and-smoke-vsix.test.ts
│       ├── manifest.test.ts
│       ├── protocol.test.ts
│       ├── python-resolver.test.ts
│       ├── run-vscode-tests.test.ts
│       ├── workflows.test.ts
│       └── workspace-trust.test.ts
├── third_party/
│   ├── runtime-components.json
│   ├── sqlparse/
│   │   ├── AUTHORS
│   │   ├── LICENSE
│   │   ├── SOURCE.json
│   │   └── files.sha256
│   └── vscode-python-extension/
│       ├── LICENSE.md
│       └── SOURCE.json
├── tools/
│   ├── build.ts
│   ├── benchmark_helper.py
│   ├── fetch_test_grammars.ts
│   ├── install_and_smoke_vsix.ts
│   ├── offline_vsix_smoke.py
│   ├── run_vscode_tests.ts
│   ├── sqlparse-vendor.lock
│   ├── sqlparse-vendor.requirements.txt
│   ├── vendor_sqlparse.py
│   ├── verify_vendor.py
│   └── verify_vsix.py
├── tsconfig.json
├── uv.lock
└── vitest.config.ts
```

## Task 1: Scaffold the repository and pass the TextMate feasibility gate

**Files:**

- Create: `.gitignore`, `.prettierignore`, `.prettierrc.json`, `bunfig.toml`,
  `package.json`, `bun.lock`, `tsconfig.json`, `eslint.config.mjs`,
  `vitest.config.ts`, `pyproject.toml`, `uv.lock`, `.pre-commit-config.yaml`
- Create: `tools/build.ts`, `tools/fetch_test_grammars.ts`
- Create: `src/extension.ts`
- Create: `syntaxes/inline-sql-python.tmLanguage.json`
- Create: `syntaxes/inline-sql-fstring-islands.tmLanguage.json`
- Create: `test/support/grammar-loader.ts`
- Create: `test/fixtures/grammar-lock.json`
- Create: `test/fixtures/grammars/marimo-python.tmLanguage.json`
- Create: `test/fixtures/grammars/marimo-LICENSE`
- Create: `test/fixtures/grammars/marimo-SOURCE.json`
- Create: `test/fixtures/pep701-grammar-cases.json`
- Create: `test/grammar/feasibility-gate.test.ts`

**Interfaces:**

```ts
export type GrammarVersion = "1.95.0" | "stable";

export interface GrammarLoadOptions {
  readonly marimoExtensionRoot?: string;
}

export interface ScopedSegment {
  readonly text: string;
  readonly requiredScopes: readonly string[];
  readonly forbiddenScopes: readonly string[];
  readonly embeddedLanguage: "python" | "sql";
}

export interface GrammarCase {
  readonly id: string;
  readonly source: string;
  readonly language: "python" | "mo-python";
  readonly segments: readonly ScopedSegment[];
}
```

- [ ] Add exact Bun and uv dependency pins from section 2. Configure TypeScript with
  `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `useUnknownInCatchVariables`, and ESM source. Configure Ruff for Python 3.12,
  88 columns, import sorting, annotations, and pytest rules. Configure Ruff and ty to
  check first-party helper, bootstrap, Python tools, and tests while excluding the
  byte-for-byte vendored tree.

```toml
[tool.ruff]
target-version = "py312"
line-length = 88
exclude = ["python/vendor", "test/fixtures"]

[tool.ty.src]
include = [
  "python/bootstrap.py",
  "python/inline_sql_helper",
  "tools",
  "test/python",
]
exclude = ["python/vendor"]

[tool.ty.environment]
extra-paths = ["python", "python/vendor"]

[tool.pytest.ini_options]
pythonpath = ["python", "python/vendor"]
testpaths = ["test/python"]
addopts = ["--strict-config", "--strict-markers"]
```

  Use `verify_vendor.py`, not Ruff or ty, as the integrity gate for upstream sqlparse.
- [ ] Define the command surface once in `package.json`; later tasks fill in the
  referenced runners without renaming scripts.

```json
{
  "scripts": {
    "build": "bun tools/build.ts",
    "format:check": "prettier --check .",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test:unit": "vitest run test/ts",
    "test:coverage": "vitest run --coverage test/ts",
    "test:grammar-gate": "vitest run test/grammar/feasibility-gate.test.ts",
    "test:grammar": "vitest run test/grammar",
    "test:integration:trusted": "bun tools/run_vscode_tests.ts trusted",
    "test:integration:untrusted": "bun tools/run_vscode_tests.ts untrusted",
    "package:vsix": "bun run build && vsce package --no-dependencies --out dist-vsix/inline-sql-toolkit-0.1.0.vsix",
    "test:vsix-install": "bun tools/install_and_smoke_vsix.ts"
  }
}
```

- [ ] Configure Vitest's Node environment to resolve the Extension Host-only `vscode`
  module to a resettable unit-test mock that Task 14 creates. Integration tests do not
  use this alias because they run inside a real Extension Host.

```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(
        new URL("./test/support/vscode-mock.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/ts/**/*.test.ts", "test/grammar/**/*.test.ts"],
    restoreMocks: true,
  },
});
```

- [ ] Exclude generated artifacts and `docs/superpowers/` from Prettier; the approved
  design and this execution plan are review records, not mechanically rewritten source.

```text
node_modules/
dist/
dist-vsix/
coverage/
reports/
.vscode-test/
docs/superpowers/
python/vendor/
test/fixtures/
```

- [ ] Add a no-op extension entry that gives the build a real Node 20 target while the
  feature lifecycle is still unimplemented.

```ts
export function activate(): void {}

export function deactivate(): void {}
```

- [ ] Implement the real minimal build runner now, so every earlier `bun run build`
  gate is executable. Task 20 adds packaging inventory assertions but does not defer
  basic bundling until then.

```ts
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";

export async function buildExtension(): Promise<Metafile> {
  await mkdir("dist", { recursive: true });
  const result = await build({
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    sourcemap: false,
    legalComments: "none",
    metafile: true,
    packages: "bundle",
  });
  if (result.metafile === undefined) {
    throw new Error("esbuild did not return a metafile");
  }
  return result.metafile;
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await buildExtension();
}
```

```bash
bun run build
node --check dist/extension.js
```

- [ ] Add `.gitignore` entries for `.DS_Store`, `.venv/`, `node_modules/`, `dist/`,
  `dist-vsix/`, `.vscode-test/`, `coverage/`, `.pytest_cache/`, `.ruff_cache/`,
  `.hypothesis/`, `__pycache__/`, `reports/`, and downloaded grammar caches.

```gitignore
.DS_Store
.venv/
node_modules/
dist/
dist-vsix/
.vscode-test/
coverage/
reports/
.pytest_cache/
.ruff_cache/
.hypothesis/
__pycache__/
*.py[cod]
test/.grammar-cache/
```

- [ ] Generate locks with the age cutoff, then prove frozen install works.

```bash
bun install --ignore-scripts
uv lock --exclude-newer 2026-07-24T00:00:00Z
bun install --frozen-lockfile --ignore-scripts
uv sync --frozen --python 3.12
```

- [ ] Write `grammar-lock.json` so the marimo grammar is pinned to commit
  `baed86d151d41b838466e6efd46ee5265e66c09f`, path
  `extension/syntaxes/python.tmLanguage.json`, scope `source.mo-python`, and SHA-256
  `a5ac4625016edb96aa9001c303a54813e291bd8c482a0d086ee6e215776d9d7b`.
  `fetch_test_grammars.ts` must reject a hash mismatch. Copy the pinned repository's
  Apache-2.0 `LICENSE` and record repository, commit, path, and grammar hash in
  `marimo-SOURCE.json`; these test-only provenance files are excluded from the VSIX.

```json
{
  "marimo": {
    "repository": "https://github.com/marimo-team/marimo-lsp",
    "commit": "baed86d151d41b838466e6efd46ee5265e66c09f",
    "path": "extension/syntaxes/python.tmLanguage.json",
    "scopeName": "source.mo-python",
    "sha256": "a5ac4625016edb96aa9001c303a54813e291bd8c482a0d086ee6e215776d9d7b",
    "license": "Apache-2.0"
  }
}
```

- [ ] Make the grammar loader use `@vscode/test-electron` to download the requested
  VS Code build, then load that build's bundled Python and SQL grammars from its
  `resources/app/extensions` tree by reading each built-in extension's
  `contributes.grammars` manifest entry. It must fail if it silently resolves a locally
  installed grammar or a grammar from the other requested VS Code version.

```ts
export async function builtinGrammarPath(
  version: GrammarVersion,
  language: "python" | "sql",
): Promise<string> {
  const executable = await downloadAndUnzipVSCode(version);
  const appRoot =
    process.platform === "darwin"
      ? resolve(executable, "../../Resources/app")
      : resolve(dirname(executable), "resources/app");
  const extensionRoot = join(appRoot, "extensions", language);
  const manifest = JSON.parse(
    await readFile(join(extensionRoot, "package.json"), "utf8"),
  ) as {
    contributes: {
      grammars: Array<{ scopeName: string; path: string }>;
    };
  };
  const contribution = manifest.contributes.grammars.find(
    ({ scopeName }) => scopeName === `source.${language}`,
  );
  if (contribution === undefined) {
    throw new Error(`Missing built-in ${language} grammar`);
  }
  return join(extensionRoot, contribution.path);
}
```

- [ ] Populate `pep701-grammar-cases.json` with separate cases for simple interpolation,
  interpolation inside an SQL quoted string, debug `=`, `!r`, nested format spec,
  multiline expression, comment in expression, same-quote string, nested f-string,
  multiple fields, and `{{`/`}}` adjacent to a field. Include both `python` and
  `mo-python` cases.

```json
{
  "id": "quoted-string-interpolation",
  "language": "python",
  "source": "query = f\"SELECT * FROM users WHERE name = '{name}'\"",
  "segments": [
    {
      "text": "SELECT",
      "requiredScopes": ["meta.embedded.inline.sql", "source.sql", "keyword"],
      "forbiddenScopes": ["meta.embedded.inline.python"],
      "embeddedLanguage": "sql"
    },
    {
      "text": "{name}",
      "requiredScopes": ["meta.embedded.inline.python", "source.python"],
      "forbiddenScopes": ["meta.embedded.inline.sql"],
      "embeddedLanguage": "python"
    }
  ]
}
```

- [ ] Write the grammar test before the candidate grammars. It must check TextMate
  scope names and the encoded language ID returned by `tokenizeLine2`, not color output.

```ts
for (const testCase of loadGrammarCases("pep701-grammar-cases.json")) {
  test(`${grammarVersion}: ${testCase.language}: ${testCase.id}`, async () => {
    await verifyPep701GrammarCase(grammarVersion, testCase);
  });
}
```

  Implement and export `verifyPep701GrammarCase()` from
  `test/support/grammar-loader.ts`. It tokenizes through the same registry, throws a
  normal `Error` when a required/forbidden scope, embedded-language ID, or
  post-literal scope fence differs, and has no Vitest import/global. The Vitest loop
  above and Task 19's outer Node runner therefore share the assertion without loading a
  test module.

```ts
export async function verifyPep701GrammarCase(
  version: GrammarVersion,
  testCase: GrammarCase,
  options: GrammarLoadOptions = {},
): Promise<void> {
  const tokens = await tokenizeWithEmbeddedLanguages(
    version,
    testCase,
    options,
  );
  assertRequiredSegments(tokens, testCase.segments);
  assertNoScopeLeakAfterLiteral(tokens, testCase.source);
}
```

  `tokenizeWithEmbeddedLanguages()` accepts the same optional
  `GrammarLoadOptions`. With no override it uses the hash-pinned test grammar. Task 19
  may pass a freshly installed official marimo extension root; in that mode the loader
  reads that root's manifest, requires one `source.mo-python` contribution, resolves
  its grammar path below the supplied root, and rejects missing/duplicate language,
  grammar, or `marimo-notebook` contributions before tokenization.

- [ ] Run the gate against VS Code 1.95.0 and confirm it fails because the injection
  grammars do not yet define the required regions.

```bash
VSCODE_TEST_VERSION=1.95.0 bun run test:grammar-gate
VSCODE_TEST_VERSION=stable bun run test:grammar-gate
```

- [ ] Implement the two candidate injection grammars. Use grammar names
  `inline-sql.python.injection` and `inline-sql.fstring-islands.injection`;
  SQL literal spans must carry `meta.embedded.inline.sql`, and replacement fields
  must carry `meta.embedded.inline.python`. The outer grammar injects into
  `source.python` and `source.mo-python`; the island grammar injects with
  `L:meta.embedded.inline.sql` priority so a field returns to the host Python grammar.
  Register embedded language IDs as `sql` and `python` in the test registry.
- [ ] Seed the outer gate with a concrete triple-string rule using the complete approved
  detector expression; single-quote and f-string rules use the same lookahead and are
  added as separate repository entries so their end states can differ.

```json
{
  "scopeName": "inline-sql.python.injection",
  "injectionSelector": "L:source.python -comment, L:source.mo-python -comment",
  "patterns": [{"include": "#plainTripleSql"}],
  "repository": {
    "plainTripleSql": {
      "begin": "(?ix)(?<![[:alnum:]_])r?(?<quote>'''|\\\"\\\"\\\")(?=[ \\t\\r\\n]*(?:(?:--(?:sql|[ ]sql)[ \\t]*(?:\\r\\n|\\r|\\n|(?=\\k<quote>)))|(?:(?:select|with|insert|update|delete|merge|create|alter|drop|truncate|explain)\\b)))",
      "end": "\\k<quote>",
      "contentName": "meta.embedded.inline.sql source.sql",
      "patterns": [{"include": "source.sql"}]
    }
  }
}
```

- [ ] Seed the field-island gate with an explicit Python delegation rule. The gate cases
  determine whether this rule can be safely extended to nested PEP 701 fields; passing
  the simple case alone is not sufficient.

```json
{
  "scopeName": "inline-sql.fstring-islands.injection",
  "injectionSelector": "L:meta.embedded.inline.sql",
  "patterns": [{"include": "#replacementField"}],
  "repository": {
    "replacementField": {
      "begin": "(?<!\\{)\\{(?!\\{)",
      "end": "(?<!\\})\\}(?!\\})",
      "contentName": "meta.embedded.inline.python source.python",
      "patterns": [{"include": "source.python"}]
    }
  }
}
```
- [ ] Re-run both commands. Inspect every required segment, field boundary, end quote,
  following Python token, and encoded language ID. Run each version twice to catch
  state leakage between lines.
- [ ] **Hard-stop decision:** if either version fails, save the failing case IDs and
  scope traces, stop execution, and ask for design review. Do not commit a claimed
  passing gate and do not begin Task 2.
- [ ] If both versions pass, run quality checks and inspect the production bundle target.

```bash
bun run format:check
bun run lint
bun run typecheck
bun run build
node --check dist/extension.js
uv run ruff check .
uv run ruff format --check .
uv run ty check
```

- [ ] Commit only after the gate passes.

```bash
git add .gitignore .prettierignore .prettierrc.json bunfig.toml package.json bun.lock \
  tsconfig.json eslint.config.mjs vitest.config.ts pyproject.toml uv.lock \
  .pre-commit-config.yaml tools/build.ts tools/fetch_test_grammars.ts \
  src/extension.ts syntaxes \
  test/support/grammar-loader.ts test/fixtures/grammar-lock.json \
  test/fixtures/grammars test/fixtures/pep701-grammar-cases.json \
  test/grammar/feasibility-gate.test.ts
git commit -m "build: prove inline SQL grammar feasibility"
```

## Task 2: Complete the production grammar and shared detection matrix

**Files:**

- Modify: `syntaxes/inline-sql-python.tmLanguage.json`
- Modify: `syntaxes/inline-sql-fstring-islands.tmLanguage.json`
- Create: `test/fixtures/sql-detection.json`
- Create: `test/support/detection-parity.ts`
- Create: `test/grammar/detection-parity.test.ts`
- Create: `test/ts/manifest.test.ts`
- Create: `package.nls.json`
- Create: `package.nls.ja.json`
- Modify: `package.json`

**Manifest contract:**

```json
{
  "engines": {"vscode": "^1.95.0"},
  "main": "./dist/extension.js",
  "activationEvents": [
    "onCommand:inlineSql.formatAtCursor",
    "onCommand:inlineSql.formatSelection",
    "onCommand:inlineSql.formatAll",
    "onLanguage:python",
    "onLanguage:mo-python"
  ],
  "capabilities": {
    "untrustedWorkspaces": {
      "supported": "limited",
      "restrictedConfigurations": ["inlineSql.pythonPath"]
    }
  }
}
```

- [ ] Write `sql-detection.json` as the single fixture source for grammar and Python
  detector tests. A `content` case contains `content` and is wrapped by the tests in
  every supported prefix/delimiter. A `source` case contains complete Python `source`
  and represents syntax-dependent shapes such as bytes, t-strings, implicit
  concatenation, `BinOp(Add)`, and invalid Python. Every item contains `id`, `kind`,
  `detectionExpected`, `formatExpectation` (`supported`, `unsupported-skip`, `ignored`,
  or `parse-error`), optional `formatExpectationByPython` overrides keyed only by
  `3.12`, `3.13`, or `3.14`, `grammarExpectation` (`sql`, `none`, or
  `implementation-defined`), and `reason`. This separates source-level SQL detection
  from formatability. Use the per-Python override for syntax whose validity changed:
  a t-string is `parse-error` on 3.12/3.13 and `ignored` on 3.14.
  Include both marker spellings and case variants, including marker lines terminated
  by CRLF, LF, and bare CR; every approved keyword and lower-case variant; whitespace
  and word boundaries; `\nSELECT`; bytes, t-strings, non-SQL prose,
  `SELECTED`, comments before keywords, implicit concatenation, and malformed Python.
  Treat `--  sql` and `--` followed by a tab before `sql` as negative internal-spacing
  cases; only `--sql` and `-- sql` are valid, with horizontal whitespace allowed around
  the complete marker.
  Use `implementation-defined` only for invalid/incomplete Python that the helper cannot
  parse; never use it to excuse bytes, unsupported prefixes, or ordinary non-SQL text.

```json
[
  {
    "id": "select-lower",
    "kind": "content",
    "content": "select 1",
    "detectionExpected": true,
    "formatExpectation": "supported",
    "grammarExpectation": "sql",
    "reason": "keyword"
  },
  {
    "id": "marker-double-space",
    "kind": "content",
    "content": "--  sql\nselect 1",
    "detectionExpected": false,
    "formatExpectation": "ignored",
    "grammarExpectation": "none",
    "reason": "invalid-marker-spacing"
  },
  {
    "id": "implicit-concatenation",
    "kind": "source",
    "source": "query = \"SELECT \" \"1\"",
    "detectionExpected": true,
    "formatExpectation": "unsupported-skip",
    "grammarExpectation": "sql",
    "reason": "unsupported-literal-shape"
  },
  {
    "id": "template-string",
    "kind": "source",
    "source": "query = t\"SELECT 1\"",
    "detectionExpected": false,
    "formatExpectation": "parse-error",
    "formatExpectationByPython": {"3.14": "ignored"},
    "grammarExpectation": "none",
    "reason": "unsupported-prefix"
  }
]
```

- [ ] Add manifest tests first. Assert name `inline-sql-toolkit`, display name
  `Inline SQL Toolkit`, publisher `hidenobunagai`, version `0.1.0`, VS Code engine,
  exactly three commands, exactly five settings, no `extensionDependencies`, limited
  workspace trust, two grammar contributions, and embedded language mappings.

```ts
it("contributes only the approved public surface", () => {
  const manifest = loadPackageJson();
  expect(manifest.contributes.commands.map(({ command }) => command)).toEqual([
    "inlineSql.formatAtCursor",
    "inlineSql.formatSelection",
    "inlineSql.formatAll",
  ]);
  expect(Object.keys(manifest.contributes.configuration.properties)).toHaveLength(5);
  expect(manifest.extensionDependencies).toBeUndefined();
  expect(manifest.capabilities.untrustedWorkspaces.supported).toBe("limited");
});
```

- [ ] Add grammar parity tests that wrap each `content` fixture in all supported prefix,
  quote, and triple-quote forms, while tokenizing each `source` fixture verbatim.
  Assert `grammarExpectation="sql"` receives SQL scope and language ID and `none`
  receives neither. Record but do not fail on the allowed additional highlighting of
  `implementation-defined` invalid/incomplete source.

```ts
const prefixes = ["", "r", "R", "f", "F", "rf", "rF", "Rf", "RF", "fr", "fR", "Fr", "FR"];
const delimiters = ["'", "\"", "'''", "\"\"\""];

await runDetectionParityForVersion(grammarVersion);
```

- [ ] Implement the parity helpers in `test/support/detection-parity.ts` and export one
  runner for the thin Vitest wrapper and Task 19.
  `tokenizeWithEmbeddedLanguages` returns decoded tokens with `text`,
  `scopes`, and `embeddedLanguage`; SQL expectation requires at least one
  `meta.embedded.inline.sql` token and every such token to report `sql`. `none`
  requires zero SQL tokens. `implementation-defined` records tokens without asserting.

```ts
async function assertDetectionGrammar(
  version: GrammarVersion,
  fixture: DetectionFixture,
  language: "python" | "mo-python",
  source: string,
  options: GrammarLoadOptions,
): Promise<void> {
  const tokens = await tokenizeWithEmbeddedLanguages(version, {
    id: fixture.id,
    language,
    source,
    segments: [],
  }, options);
  const sqlTokens = tokens.filter((token) =>
    token.scopes.includes("meta.embedded.inline.sql"),
  );
  if (fixture.grammarExpectation === "implementation-defined") return;
  if (fixture.grammarExpectation === "sql") {
    if (
      sqlTokens.length === 0 ||
      sqlTokens.some((token) => token.embeddedLanguage !== "sql")
    ) {
      throw new Error(`missing SQL grammar scope: ${fixture.id}`);
    }
  } else if (sqlTokens.length !== 0) {
    throw new Error(`unexpected SQL grammar scope: ${fixture.id}`);
  }
}

async function assertWrappedGrammarDetection(
  version: GrammarVersion,
  fixture: ContentDetectionFixture,
  prefix: string,
  delimiter: string,
  options: GrammarLoadOptions,
): Promise<void> {
  for (const language of ["python", "mo-python"] as const) {
    await assertDetectionGrammar(
      version,
      fixture,
      language,
      `query = ${prefix}${delimiter}${fixture.content}${delimiter}`,
      options,
    );
  }
}

async function assertSourceGrammarDetection(
  version: GrammarVersion,
  fixture: SourceDetectionFixture,
  options: GrammarLoadOptions,
): Promise<void> {
  for (const language of ["python", "mo-python"] as const) {
    await assertDetectionGrammar(
      version,
      fixture,
      language,
      fixture.source,
      options,
    );
  }
}

export async function runDetectionParityForVersion(
  version: GrammarVersion,
  options: GrammarLoadOptions = {},
): Promise<void> {
  for (const fixture of loadDetectionFixtures()) {
    if (fixture.kind === "content") {
      for (const prefix of prefixes) {
        for (const delimiter of delimiters) {
          await assertWrappedGrammarDetection(
            version,
            fixture,
            prefix,
            delimiter,
            options,
          );
        }
      }
    } else {
      await assertSourceGrammarDetection(version, fixture, options);
    }
  }
}
```

  Put these exported helpers and the strict fixture loader in
  `test/support/detection-parity.ts`, which imports no Vitest globals. The
  `detection-parity.test.ts` file only invokes the runner for its requested version;
  Task 19 imports the same support module rather than importing a `*.test.ts` file.

- [ ] Run the tests and confirm failures for missing manifest contributions, keyword
  variants, raw/f-string prefix variants, bytes exclusion, and end-of-literal scope
  cleanup.

```bash
bun run test:unit -- test/ts/manifest.test.ts
VSCODE_TEST_VERSION=1.95.0 bun run test:grammar
```

- [ ] Implement production grammar patterns and package contributions. Map
  `meta.embedded.inline.sql` to `sql` and `meta.embedded.inline.python` to `python`.
  Inject into both `source.python` and `source.mo-python`; exclude byte and t-string
  prefixes; do not add fixed theme colors.

```json
{
  "contributes": {
    "grammars": [
      {
        "scopeName": "inline-sql.python.injection",
        "path": "./syntaxes/inline-sql-python.tmLanguage.json",
        "injectTo": ["source.python", "source.mo-python"],
        "embeddedLanguages": {
          "meta.embedded.inline.sql": "sql"
        }
      },
      {
        "scopeName": "inline-sql.fstring-islands.injection",
        "path": "./syntaxes/inline-sql-fstring-islands.tmLanguage.json",
        "injectTo": ["source.python", "source.mo-python"],
        "embeddedLanguages": {
          "meta.embedded.inline.python": "python"
        }
      }
    ]
  }
}
```

- [ ] Run minimum and stable grammar suites, then the full TypeScript quality suite.

```bash
VSCODE_TEST_VERSION=1.95.0 bun run test:grammar
VSCODE_TEST_VERSION=stable bun run test:grammar
bun run test:unit
bun run lint
bun run typecheck
```

- [ ] Commit the completed declarative surface.

```bash
git add package.json package.nls.json package.nls.ja.json syntaxes \
  test/fixtures/sql-detection.json test/support/detection-parity.ts \
  test/grammar/detection-parity.test.ts test/ts/manifest.test.ts
git commit -m "feat: highlight inline SQL in Python strings"
```

## Task 3: Define and enforce the versioned JSON protocol

**Files:**

- Create: `protocol/v1.schema.json`
- Create: `src/constants.ts`
- Create: `src/protocol.ts`
- Create: `python/inline_sql_helper/__init__.py`
- Create: `python/inline_sql_helper/model.py`
- Create: `python/inline_sql_helper/protocol.py`
- Create: `test/fixtures/helper/protocol-cases.json`
- Create: `test/support/helper-fixtures.ts`
- Create: `test/ts/protocol.test.ts`
- Create: `test/python/test_protocol.py`

**TypeScript contract:**

```ts
export const PROTOCOL_VERSION = 1 as const;

export type FormatMode = "cursor" | "selection" | "all";
export type ProtocolOperation = "locate" | "format";
export type ProtocolValueKind =
  | "request"
  | "locateResponse"
  | "formatResponse"
  | "preDispatchError";
export type ReasonCode = (typeof REASON_CODES)[number];

export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface TextRange {
  readonly start: Position;
  readonly end: Position;
}

export interface FormatOptions {
  readonly keywordCase: "upper" | "lower" | "preserve";
  readonly indentWidth: number;
  readonly wrapAfter: number;
  readonly useSpaceAroundOperators: boolean;
}

export interface FormatTarget {
  readonly mode: FormatMode;
  readonly cursor?: Position;
  readonly selection?: TextRange;
}

export interface HelperRequest {
  readonly protocolVersion: 1;
  readonly operation: ProtocolOperation;
  readonly source: string;
  readonly target: FormatTarget;
  readonly options: FormatOptions;
}

export interface FormatEdit {
  readonly range: TextRange;
  readonly expectedText: string;
  readonly newText: string;
}

export interface CandidateSkipPayload {
  readonly range: TextRange;
  readonly reason: ReasonCode;
}

export interface FormatSummary {
  readonly discovered: number;
  readonly selected: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly skipped: number;
}

export interface LocateSuccess {
  readonly protocolVersion: 1;
  readonly operation: "locate";
  readonly ok: true;
  readonly candidates: readonly TextRange[];
}

export interface FormatSuccess {
  readonly protocolVersion: 1;
  readonly operation: "format";
  readonly ok: true;
  readonly edits: readonly FormatEdit[];
  readonly skips: readonly CandidateSkipPayload[];
  readonly summary: FormatSummary;
}

export interface ErrorResponse {
  readonly protocolVersion: 1;
  readonly operation: ProtocolOperation | "unknown";
  readonly ok: false;
  readonly error: { readonly code: ReasonCode };
}

export type LocateResponse = LocateSuccess | ErrorResponse;
export type FormatResponse = FormatSuccess | ErrorResponse;

export class ProtocolViolation extends Error {
  readonly code = "PROTOCOL_ERROR" as const;

  constructor(code: "PROTOCOL_ERROR" = "PROTOCOL_ERROR") {
    super(code);
    this.name = "ProtocolViolation";
  }
}
```

The exported overloads for `parseProtocolValue()` are written contiguously with its
implementation below; `serializeRequest()` is exported there as well. Do not leave
ambient/no-body function declarations in `src/protocol.ts`.

**Python contract:**

```py
from dataclasses import dataclass
from enum import StrEnum
from typing import Literal, Never, TypeVar, assert_never, cast


class FormatMode(StrEnum):
    CURSOR = "cursor"
    SELECTION = "selection"
    ALL = "all"


class ProtocolOperation(StrEnum):
    LOCATE = "locate"
    FORMAT = "format"


class ReasonCode(StrEnum):
    PYTHON_NOT_FOUND = "PYTHON_NOT_FOUND"
    PYTHON_VERSION_UNSUPPORTED = "PYTHON_VERSION_UNSUPPORTED"
    WORKSPACE_UNTRUSTED = "WORKSPACE_UNTRUSTED"
    INVALID_CONFIGURATION = "INVALID_CONFIGURATION"
    DOCUMENT_PARSE_FAILED = "DOCUMENT_PARSE_FAILED"
    NO_SQL_CANDIDATE = "NO_SQL_CANDIDATE"
    UNSUPPORTED_LITERAL = "UNSUPPORTED_LITERAL"
    UNSAFE_FSTRING_RESTORE = "UNSAFE_FSTRING_RESTORE"
    UNSAFE_RAW_STRING = "UNSAFE_RAW_STRING"
    FORMATTER_FAILED = "FORMATTER_FAILED"
    RESOURCE_LIMIT_EXCEEDED = "RESOURCE_LIMIT_EXCEEDED"
    PROCESS_TIMEOUT = "PROCESS_TIMEOUT"
    PROCESS_CANCELLED = "PROCESS_CANCELLED"
    PROCESS_FAILED = "PROCESS_FAILED"
    DOCUMENT_CHANGED = "DOCUMENT_CHANGED"
    APPLY_EDIT_FAILED = "APPLY_EDIT_FAILED"
    PROTOCOL_ERROR = "PROTOCOL_ERROR"


@dataclass(frozen=True, slots=True)
class Position:
    line: int
    character: int


@dataclass(frozen=True, slots=True)
class TextRange:
    start: Position
    end: Position


@dataclass(frozen=True, slots=True)
class FormatOptions:
    keyword_case: Literal["upper", "lower", "preserve"]
    indent_width: int
    wrap_after: int
    use_space_around_operators: bool


@dataclass(frozen=True, slots=True)
class FormatTarget:
    mode: FormatMode
    cursor: Position | None = None
    selection: TextRange | None = None


@dataclass(frozen=True, slots=True)
class HelperRequest:
    protocol_version: Literal[1]
    operation: ProtocolOperation
    source: str
    target: FormatTarget
    options: FormatOptions


@dataclass(frozen=True, slots=True)
class FormatEdit:
    range: TextRange
    expected_text: str
    new_text: str


@dataclass(frozen=True, slots=True)
class CandidateSkipPayload:
    range: TextRange
    reason: ReasonCode


@dataclass(frozen=True, slots=True)
class FormatSummary:
    discovered: int
    selected: int
    changed: int
    unchanged: int
    skipped: int


@dataclass(frozen=True, slots=True)
class LocateSuccess:
    protocol_version: Literal[1]
    operation: Literal[ProtocolOperation.LOCATE]
    ok: Literal[True]
    candidates: tuple[TextRange, ...]


@dataclass(frozen=True, slots=True)
class FormatSuccess:
    protocol_version: Literal[1]
    operation: Literal[ProtocolOperation.FORMAT]
    ok: Literal[True]
    edits: tuple[FormatEdit, ...]
    skips: tuple[CandidateSkipPayload, ...]
    summary: FormatSummary


@dataclass(frozen=True, slots=True)
class ErrorPayload:
    code: ReasonCode


@dataclass(frozen=True, slots=True)
class ErrorResponse:
    protocol_version: Literal[1]
    operation: ProtocolOperation | Literal["unknown"]
    ok: Literal[False]
    error: ErrorPayload


type LocateResponse = LocateSuccess | ErrorResponse
type FormatResponse = FormatSuccess | ErrorResponse
type HelperResponse = LocateSuccess | FormatSuccess | ErrorResponse
```

`protocol.py`のpublic surfaceは次に固定し、Tasks 4–13はこの型をimportする。

```py
class ProtocolViolation(ValueError):
    code = ReasonCode.PROTOCOL_ERROR


def parse_request(value: object) -> HelperRequest:
    """Validate one decoded request and construct frozen model values."""


def parse_request_json(payload: bytes) -> HelperRequest:
    """Decode strict UTF-8 and validate one JSON request."""


def serialize_request(request: HelperRequest) -> bytes:
    """Serialize compact UTF-8 JSON for cross-language round-trip tests."""


def serialize_response(response: HelperResponse) -> bytes:
    """Serialize exactly one compact UTF-8 JSON response."""


def error_response(
    operation: ProtocolOperation | Literal["unknown"],
    code: ReasonCode,
) -> ErrorResponse:
    """Construct a source-free request error."""


type ProtocolValueKind = Literal[
    "request",
    "locateResponse",
    "formatResponse",
    "preDispatchError",
]


@dataclass(frozen=True, slots=True)
class ProtocolFixtureCase:
    name: str
    kind: ProtocolValueKind
    value: object


def parse_protocol_value(
    kind: ProtocolValueKind,
    value: object,
) -> HelperRequest | LocateResponse | FormatResponse:
    """Validate one request or context-specific response value."""
```

`locate`はcandidate rangeだけを返し、editを返さない。`format`はedit、candidate skip、
summaryを返す。成功responseとerror responseは`ok` discriminantを持つ。editは`range`,
`expectedText`, `newText`を持つ。error responseの`edits` propertyは禁止する。requestの
operationを読み取る前に失敗するmalformed UTF-8、malformed JSON、空stdinだけは
`operation: "unknown"`を返す。operationを読み取れた後のerrorは元のoperationと一致させる。

- [ ] Create a strict JSON Schema with `additionalProperties: false` at every object
  level. Encode mode-specific property presence: cursor mode requires `cursor`;
  selection requires `selection`; all forbids both. JSON Schema validates structure,
  but the hand-written validators must enforce non-empty/non-reversed selection,
  position ordering, and edit non-overlap. Encode all reason codes as one enum shared by
  success skips and errors.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://inline-sql-toolkit.dev/protocol/v1.schema.json",
  "oneOf": [
    { "$ref": "#/$defs/request" },
    { "$ref": "#/$defs/locateSuccess" },
    { "$ref": "#/$defs/formatSuccess" },
    { "$ref": "#/$defs/errorResponse" }
  ],
  "$defs": {
    "position": {
      "type": "object",
      "additionalProperties": false,
      "required": ["line", "character"],
      "properties": {
        "line": { "type": "integer", "minimum": 0 },
        "character": { "type": "integer", "minimum": 0 }
      }
    },
    "range": {
      "type": "object",
      "additionalProperties": false,
      "required": ["start", "end"],
      "properties": {
        "start": { "$ref": "#/$defs/position" },
        "end": { "$ref": "#/$defs/position" }
      }
    },
    "target": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["mode", "cursor"],
          "properties": {
            "mode": { "const": "cursor" },
            "cursor": { "$ref": "#/$defs/position" }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["mode", "selection"],
          "properties": {
            "mode": { "const": "selection" },
            "selection": { "$ref": "#/$defs/range" }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["mode"],
          "properties": { "mode": { "const": "all" } }
        }
      ]
    },
    "options": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "keywordCase",
        "indentWidth",
        "wrapAfter",
        "useSpaceAroundOperators"
      ],
      "properties": {
        "keywordCase": { "enum": ["upper", "lower", "preserve"] },
        "indentWidth": { "type": "integer", "minimum": 1, "maximum": 8 },
        "wrapAfter": { "type": "integer", "minimum": 20, "maximum": 500 },
        "useSpaceAroundOperators": { "type": "boolean" }
      }
    },
    "reason": {
      "enum": [
        "PYTHON_NOT_FOUND",
        "PYTHON_VERSION_UNSUPPORTED",
        "WORKSPACE_UNTRUSTED",
        "INVALID_CONFIGURATION",
        "DOCUMENT_PARSE_FAILED",
        "NO_SQL_CANDIDATE",
        "UNSUPPORTED_LITERAL",
        "UNSAFE_FSTRING_RESTORE",
        "UNSAFE_RAW_STRING",
        "FORMATTER_FAILED",
        "RESOURCE_LIMIT_EXCEEDED",
        "PROCESS_TIMEOUT",
        "PROCESS_CANCELLED",
        "PROCESS_FAILED",
        "DOCUMENT_CHANGED",
        "APPLY_EDIT_FAILED",
        "PROTOCOL_ERROR"
      ]
    },
    "request": {
      "type": "object",
      "additionalProperties": false,
      "required": ["protocolVersion", "operation", "source", "target", "options"],
      "properties": {
        "protocolVersion": { "const": 1 },
        "operation": { "enum": ["locate", "format"] },
        "source": { "type": "string" },
        "target": { "$ref": "#/$defs/target" },
        "options": { "$ref": "#/$defs/options" }
      }
    },
    "edit": {
      "type": "object",
      "additionalProperties": false,
      "required": ["range", "expectedText", "newText"],
      "properties": {
        "range": { "$ref": "#/$defs/range" },
        "expectedText": { "type": "string" },
        "newText": { "type": "string" }
      }
    },
    "skip": {
      "type": "object",
      "additionalProperties": false,
      "required": ["range", "reason"],
      "properties": {
        "range": { "$ref": "#/$defs/range" },
        "reason": { "$ref": "#/$defs/reason" }
      }
    },
    "summary": {
      "type": "object",
      "additionalProperties": false,
      "required": ["discovered", "selected", "changed", "unchanged", "skipped"],
      "properties": {
        "discovered": { "type": "integer", "minimum": 0 },
        "selected": { "type": "integer", "minimum": 0 },
        "changed": { "type": "integer", "minimum": 0 },
        "unchanged": { "type": "integer", "minimum": 0 },
        "skipped": { "type": "integer", "minimum": 0 }
      }
    },
    "locateSuccess": {
      "type": "object",
      "additionalProperties": false,
      "required": ["protocolVersion", "operation", "ok", "candidates"],
      "properties": {
        "protocolVersion": { "const": 1 },
        "operation": { "const": "locate" },
        "ok": { "const": true },
        "candidates": {
          "type": "array",
          "items": { "$ref": "#/$defs/range" }
        }
      }
    },
    "formatSuccess": {
      "type": "object",
      "additionalProperties": false,
      "required": ["protocolVersion", "operation", "ok", "edits", "skips", "summary"],
      "properties": {
        "protocolVersion": { "const": 1 },
        "operation": { "const": "format" },
        "ok": { "const": true },
        "edits": { "type": "array", "items": { "$ref": "#/$defs/edit" } },
        "skips": { "type": "array", "items": { "$ref": "#/$defs/skip" } },
        "summary": { "$ref": "#/$defs/summary" }
      }
    },
    "errorResponse": {
      "type": "object",
      "additionalProperties": false,
      "required": ["protocolVersion", "operation", "ok", "error"],
      "properties": {
        "protocolVersion": { "const": 1 },
        "operation": { "enum": ["locate", "format", "unknown"] },
        "ok": { "const": false },
        "error": {
          "type": "object",
          "additionalProperties": false,
          "required": ["code"],
          "properties": { "code": { "$ref": "#/$defs/reason" } }
        }
      }
    }
  }
}
```

- [ ] Write invalid fixtures for unknown keys, protocol version 0 and 2, negative
  positions, reversed ranges, missing mode payload, invalid setting bounds, edits in
  error responses, overlapping edit ranges, unsafe integers above
  `9_007_199_254_740_991`, and a response containing non-string text. Add summary
  relation mismatches for edit/skip lengths and
  `changed + unchanged + skipped == selected <= discovered`. Add Python JSON text
  containing `NaN`, `Infinity`, or `-Infinity`; it must be rejected just as
  `JSON.parse` rejects it. Add valid pre-dispatch errors with `operation: "unknown"`
  and invalid success responses or parsed-request errors that use `"unknown"`.

```json
{
  "valid": [
    {
      "name": "valid-locate-request",
      "kind": "request",
      "value": {
        "protocolVersion": 1,
        "operation": "locate",
        "source": "query = \"SELECT 1\"",
        "target": { "mode": "all" },
        "options": {
          "keywordCase": "upper",
          "indentWidth": 2,
          "wrapAfter": 88,
          "useSpaceAroundOperators": true
        }
      }
    },
    {
      "name": "valid-pre-dispatch-error",
      "kind": "preDispatchError",
      "value": {
        "protocolVersion": 1,
        "operation": "unknown",
        "ok": false,
        "error": { "code": "PROTOCOL_ERROR" }
      }
    }
  ],
  "invalid": [
    {
      "name": "negative-cursor-line",
      "kind": "request",
      "value": {
        "protocolVersion": 1,
        "operation": "locate",
        "source": "",
        "target": { "mode": "cursor", "cursor": { "line": -1, "character": 0 } },
        "options": {
          "keywordCase": "upper",
          "indentWidth": 2,
          "wrapAfter": 88,
          "useSpaceAroundOperators": true
        }
      }
    },
    {
      "name": "error-response-with-edits",
      "kind": "formatResponse",
      "value": {
        "protocolVersion": 1,
        "operation": "format",
        "ok": false,
        "error": { "code": "PROTOCOL_ERROR" },
        "edits": []
      }
    }
  ]
}
```

`protocol-cases.json`には上の代表例に加え、列挙した各invalid classを一件ずつ
名前付きcaseとして記録する。fixture loaderはcase名をpytest/Vitestのtest名に含め、
不足classをmanifest-style testで検出する。

- [ ] Implement both fixture loaders before protocol tests. Fixture metadata has exact
  keys `name`, `kind`, and `value`; section names are only `valid`/`invalid`, case names
  are unique, and kind is one of the four context kinds. The loader validates metadata
  independently instead of calling the production parser under test.

```ts
export interface ProtocolFixtureCase {
  readonly name: string;
  readonly kind:
    | "request"
    | "locateResponse"
    | "formatResponse"
    | "preDispatchError";
  readonly value: unknown;
}

const fixtureKinds = new Set([
  "request",
  "locateResponse",
  "formatResponse",
  "preDispatchError",
]);

function requireFixtureRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid protocol fixture object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")
  ) {
    throw new Error("invalid protocol fixture keys");
  }
  return record;
}

export function loadProtocolCases(
  section: "valid" | "invalid",
): readonly ProtocolFixtureCase[] {
  const decoded: unknown = JSON.parse(
    readFileSync("test/fixtures/helper/protocol-cases.json", "utf8"),
  );
  const root = requireFixtureRecord(decoded, ["valid", "invalid"]);
  const values = root[section];
  if (!Array.isArray(values)) throw new Error("invalid protocol fixture section");
  const names = new Set<string>();
  return values.map((value) => {
    const item = requireFixtureRecord(value, ["name", "kind", "value"]);
    if (
      typeof item.name !== "string" ||
      !fixtureKinds.has(item.kind as string) ||
      names.has(item.name)
    ) {
      throw new Error("invalid protocol fixture case");
    }
    names.add(item.name);
    return {
      name: item.name,
      kind: item.kind as ProtocolFixtureCase["kind"],
      value: item.value,
    };
  });
}
```

```py
def require_fixture_dict(
    value: object,
    keys: frozenset[str],
) -> dict[str, object]:
    if not isinstance(value, dict):
        raise AssertionError("invalid protocol fixture object")
    if not all(isinstance(key, str) for key in value):
        raise AssertionError("invalid protocol fixture key")
    record = cast(dict[str, object], value)
    if frozenset(record) != keys:
        raise AssertionError("invalid protocol fixture keys")
    return record


def load_protocol_cases(
    section: Literal["valid", "invalid"],
) -> tuple[ProtocolFixtureCase, ...]:
    decoded: object = json.loads(
        Path("test/fixtures/helper/protocol-cases.json").read_text(
            encoding="utf-8"
        )
    )
    root = require_fixture_dict(decoded, frozenset({"valid", "invalid"}))
    values = root[section]
    if not isinstance(values, list):
        raise AssertionError("invalid protocol fixture section")
    result: list[ProtocolFixtureCase] = []
    names: set[str] = set()
    for value in values:
        item = require_fixture_dict(
            value,
            frozenset({"name", "kind", "value"}),
        )
        name = item["name"]
        kind = item["kind"]
        if (
            not isinstance(name, str)
            or name in names
            or kind not in get_args(ProtocolValueKind)
        ):
            raise AssertionError("invalid protocol fixture case")
        names.add(name)
        result.append(
            ProtocolFixtureCase(
                name,
                cast(ProtocolValueKind, kind),
                item["value"],
            )
        )
    return tuple(result)


def valid_request_json() -> str:
    case = next(
        case
        for case in load_protocol_cases("valid")
        if case.kind == "request"
    )
    return json.dumps(case.value, ensure_ascii=False, separators=(",", ":"))
```

- [ ] Write TypeScript and Python tests first. Both implementations must accept every
  valid fixture and reject every invalid fixture with `PROTOCOL_ERROR`.

```ts
for (const testCase of loadProtocolCases("invalid")) {
  test(`rejects ${testCase.name}`, () => {
    expect(() => parseProtocolValue(testCase.kind, testCase.value)).toThrow(
      new ProtocolViolation("PROTOCOL_ERROR"),
    );
  });
}
```

```py
@pytest.mark.parametrize("case", load_protocol_cases("invalid"))
def test_invalid_protocol_case_is_rejected(case: ProtocolFixtureCase) -> None:
    with pytest.raises(ProtocolViolation):
        parse_protocol_value(case.kind, case.value)


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
def test_nonstandard_json_number_is_rejected(constant: str) -> None:
    with pytest.raises(ProtocolViolation):
        parse_request_json(valid_request_json().replace("88", constant, 1).encode())
```

- [ ] Run both suites and confirm they fail because protocol parsers do not exist.

```bash
bun run test:unit -- test/ts/protocol.test.ts
uv run pytest test/python/test_protocol.py -q
```

- [ ] Implement strict, hand-written `unknown` validation in TypeScript and dataclass
  construction in Python. Do not silently coerce number, enum, or missing property
  values. Python dataclasses must use `frozen=True` and `slots=True`.

```ts
export const REASON_CODES = [
  "PYTHON_NOT_FOUND",
  "PYTHON_VERSION_UNSUPPORTED",
  "WORKSPACE_UNTRUSTED",
  "INVALID_CONFIGURATION",
  "DOCUMENT_PARSE_FAILED",
  "NO_SQL_CANDIDATE",
  "UNSUPPORTED_LITERAL",
  "UNSAFE_FSTRING_RESTORE",
  "UNSAFE_RAW_STRING",
  "FORMATTER_FAILED",
  "RESOURCE_LIMIT_EXCEEDED",
  "PROCESS_TIMEOUT",
  "PROCESS_CANCELLED",
  "PROCESS_FAILED",
  "DOCUMENT_CHANGED",
  "APPLY_EDIT_FAILED",
  "PROTOCOL_ERROR",
] as const;

function requireExactObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolViolation("PROTOCOL_ERROR");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ProtocolViolation("PROTOCOL_ERROR");
  }
  return record;
}

function requireNonNegativeInteger(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new ProtocolViolation();
  }
  return value;
}

function parsePosition(value: unknown): Position {
  const record = requireExactObject(value, ["line", "character"]);
  return {
    line: requireNonNegativeInteger(record.line),
    character: requireNonNegativeInteger(record.character),
  };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolViolation();
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new ProtocolViolation();
  return value;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ProtocolViolation();
  return value;
}

function requireLiteral<const T extends string | number | boolean>(
  value: unknown,
  expected: T,
): T {
  if (value !== expected) throw new ProtocolViolation();
  return expected;
}

function requireEnum<const T extends string>(
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ProtocolViolation();
  }
  return value as T;
}

function parseArray<T>(
  value: unknown,
  parseItem: (item: unknown) => T,
): readonly T[] {
  if (!Array.isArray(value)) throw new ProtocolViolation();
  return value.map(parseItem);
}

function comparePosition(left: Position, right: Position): number {
  return left.line === right.line
    ? Math.sign(left.character - right.character)
    : Math.sign(left.line - right.line);
}

function parseOptions(value: unknown): FormatOptions {
  const record = requireExactObject(value, [
    "keywordCase",
    "indentWidth",
    "wrapAfter",
    "useSpaceAroundOperators",
  ]);
  const indentWidth = requireNonNegativeInteger(record.indentWidth);
  const wrapAfter = requireNonNegativeInteger(record.wrapAfter);
  if (indentWidth < 1 || indentWidth > 8 || wrapAfter < 20 || wrapAfter > 500) {
    throw new ProtocolViolation();
  }
  return {
    keywordCase: requireEnum(record.keywordCase, [
      "upper",
      "lower",
      "preserve",
    ]),
    indentWidth,
    wrapAfter,
    useSpaceAroundOperators: requireBoolean(record.useSpaceAroundOperators),
  };
}

const reasonCodeSet = new Set<string>(REASON_CODES);

function parseReasonCode(value: unknown): ReasonCode {
  if (typeof value !== "string" || !reasonCodeSet.has(value)) {
    throw new ProtocolViolation();
  }
  return value as ReasonCode;
}

function validateOrderedNonOverlappingEdits(
  edits: readonly FormatEdit[],
): void {
  const ordered = [...edits].sort((left, right) =>
    comparePosition(left.range.start, right.range.start),
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (comparePosition(current.range.start, previous.range.end) < 0) {
      throw new ProtocolViolation();
    }
  }
}
```

```py
@dataclass(frozen=True, slots=True)
class Position:
    line: int
    character: int


def require_exact_dict(
    value: object,
    keys: frozenset[str],
) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ProtocolViolation
    if not all(isinstance(key, str) for key in value):
        raise ProtocolViolation
    record = {str(key): item for key, item in value.items()}
    if frozenset(record) != keys:
        raise ProtocolViolation
    return record


def require_non_negative_int(value: object) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > 9_007_199_254_740_991
    ):
        raise ProtocolViolation
    return value


def parse_position(value: object) -> Position:
    record = require_exact_dict(value, frozenset({"line", "character"}))
    return Position(
        line=require_non_negative_int(record["line"]),
        character=require_non_negative_int(record["character"]),
    )


TScalar = TypeVar("TScalar", str, int, bool)


def require_literal(value: object, expected: TScalar) -> TScalar:
    if type(value) is not type(expected) or value != expected:
        raise ProtocolViolation
    return expected


def require_str(value: object) -> str:
    if not isinstance(value, str):
        raise ProtocolViolation
    return value


def require_enum(value: object, allowed: set[str]) -> str:
    result = require_str(value)
    if result not in allowed:
        raise ProtocolViolation
    return result


def require_reason(value: object) -> str:
    result = require_str(value)
    if result not in {reason.value for reason in ReasonCode}:
        raise ProtocolViolation
    return result


def require_list(value: object) -> list[object]:
    if not isinstance(value, list):
        raise ProtocolViolation
    return cast(list[object], value)


def compare_position(left: Position, right: Position) -> int:
    left_key = (left.line, left.character)
    right_key = (right.line, right.character)
    return (left_key > right_key) - (left_key < right_key)


def parse_range(value: object, *, allow_empty: bool = True) -> TextRange:
    record = require_exact_dict(value, frozenset({"start", "end"}))
    result = TextRange(
        parse_position(record["start"]),
        parse_position(record["end"]),
    )
    order = compare_position(result.start, result.end)
    if order > 0 or (order == 0 and not allow_empty):
        raise ProtocolViolation
    return result


def parse_format_options(value: object) -> FormatOptions:
    record = require_exact_dict(
        value,
        frozenset(
            {
                "keywordCase",
                "indentWidth",
                "wrapAfter",
                "useSpaceAroundOperators",
            }
        ),
    )
    keyword_case = require_enum(
        record["keywordCase"],
        {"upper", "lower", "preserve"},
    )
    indent_width = require_non_negative_int(record["indentWidth"])
    wrap_after = require_non_negative_int(record["wrapAfter"])
    spacing = record["useSpaceAroundOperators"]
    if (
        not 1 <= indent_width <= 8
        or not 20 <= wrap_after <= 500
        or not isinstance(spacing, bool)
    ):
        raise ProtocolViolation
    return FormatOptions(
        cast(Literal["upper", "lower", "preserve"], keyword_case),
        indent_width,
        wrap_after,
        spacing,
    )


def validate_ordered_non_overlapping_edits(response: FormatSuccess) -> None:
    ordered = sorted(
        response.edits,
        key=lambda edit: (
            edit.range.start.line,
            edit.range.start.character,
        ),
    )
    for previous, current in itertools.pairwise(ordered):
        if compare_position(current.range.start, previous.range.end) < 0:
            raise ProtocolViolation


def reject_json_constant(_value: str) -> Never:
    raise ProtocolViolation


def decode_json(payload: bytes) -> object:
    try:
        text = payload.decode("utf-8", errors="strict")
        return json.loads(text, parse_constant=reject_json_constant)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolViolation from error
```

- [ ] Compose TypeScript request parsing from the primitives. Parse mode-specific
  target keys separately, enforce non-empty ordered selection, and construct a fresh
  typed object so no unvalidated reference escapes.

```ts
function parseRange(value: unknown, allowEmpty = true): TextRange {
  const record = requireExactObject(value, ["start", "end"]);
  const result = {
    start: parsePosition(record.start),
    end: parsePosition(record.end),
  };
  const order = comparePosition(result.start, result.end);
  if (order > 0 || (!allowEmpty && order === 0)) {
    throw new ProtocolViolation();
  }
  return result;
}

function parseTarget(value: unknown): FormatTarget {
  const object = requireObject(value);
  if (object.mode === "cursor") {
    const record = requireExactObject(value, ["mode", "cursor"]);
    return { mode: "cursor", cursor: parsePosition(record.cursor) };
  }
  if (object.mode === "selection") {
    const record = requireExactObject(value, ["mode", "selection"]);
    return {
      mode: "selection",
      selection: parseRange(record.selection, false),
    };
  }
  requireExactObject(value, ["mode"]);
  if (object.mode !== "all") throw new ProtocolViolation();
  return { mode: "all" };
}

function parseRequest(value: unknown): HelperRequest {
  const record = requireExactObject(value, [
    "protocolVersion",
    "operation",
    "source",
    "target",
    "options",
  ]);
  return {
    protocolVersion: requireLiteral(record.protocolVersion, 1),
    operation: requireEnum(record.operation, ["locate", "format"]),
    source: requireString(record.source),
    target: parseTarget(record.target),
    options: parseOptions(record.options),
  };
}
```

- [ ] Compose response parsing and context dispatch. Error operation must match the
  parsed request context; only `preDispatchError` accepts `"unknown"`. Locate ranges
  and format edits/skips are constructed element-by-element. Enforce non-empty edit
  ranges/text expectations, unique/non-overlapping edits, and summary relations before
  returning.

```ts
function parseErrorResponse(
  value: unknown,
  operation: ProtocolOperation | "unknown",
): ErrorResponse {
  const record = requireExactObject(value, [
    "protocolVersion",
    "operation",
    "ok",
    "error",
  ]);
  const error = requireExactObject(record.error, ["code"]);
  return {
    protocolVersion: requireLiteral(record.protocolVersion, 1),
    operation: requireLiteral(record.operation, operation),
    ok: requireLiteral(record.ok, false),
    error: { code: parseReasonCode(error.code) },
  };
}

function parseEdit(value: unknown): FormatEdit {
  const record = requireExactObject(value, [
    "range",
    "expectedText",
    "newText",
  ]);
  const expectedText = requireString(record.expectedText);
  if (expectedText.length === 0) throw new ProtocolViolation();
  return {
    range: parseRange(record.range, false),
    expectedText,
    newText: requireString(record.newText),
  };
}

function parseSkip(value: unknown): CandidateSkipPayload {
  const record = requireExactObject(value, ["range", "reason"]);
  return {
    range: parseRange(record.range, false),
    reason: parseReasonCode(record.reason),
  };
}

function parseSummary(value: unknown): FormatSummary {
  const record = requireExactObject(value, [
    "discovered",
    "selected",
    "changed",
    "unchanged",
    "skipped",
  ]);
  return {
    discovered: requireNonNegativeInteger(record.discovered),
    selected: requireNonNegativeInteger(record.selected),
    changed: requireNonNegativeInteger(record.changed),
    unchanged: requireNonNegativeInteger(record.unchanged),
    skipped: requireNonNegativeInteger(record.skipped),
  };
}

function parseFormatSuccessObject(value: unknown): FormatSuccess {
  const record = requireExactObject(value, [
    "protocolVersion",
    "operation",
    "ok",
    "edits",
    "skips",
    "summary",
  ]);
  return {
    protocolVersion: requireLiteral(record.protocolVersion, 1),
    operation: requireLiteral(record.operation, "format"),
    ok: requireLiteral(record.ok, true),
    edits: parseArray(record.edits, parseEdit),
    skips: parseArray(record.skips, parseSkip),
    summary: parseSummary(record.summary),
  };
}

function parseLocateResponse(value: unknown): LocateResponse {
  const object = requireObject(value);
  if (object.ok === false) return parseErrorResponse(value, "locate");
  const record = requireExactObject(value, [
    "protocolVersion",
    "operation",
    "ok",
    "candidates",
  ]);
  return {
    protocolVersion: requireLiteral(record.protocolVersion, 1),
    operation: requireLiteral(record.operation, "locate"),
    ok: requireLiteral(record.ok, true),
    candidates: parseArray(record.candidates, (item) => parseRange(item, false)),
  };
}

function parseFormatResponse(value: unknown): FormatResponse {
  const object = requireObject(value);
  if (object.ok === false) return parseErrorResponse(value, "format");
  const response = parseFormatSuccessObject(value);
  validateOrderedNonOverlappingEdits(response.edits);
  return validateFormatRelations(response);
}

function assertNever(value: never): never {
  void value;
  throw new ProtocolViolation();
}

export function parseProtocolValue(
  kind: "request",
  value: unknown,
): HelperRequest;
export function parseProtocolValue(
  kind: "locateResponse",
  value: unknown,
): LocateResponse;
export function parseProtocolValue(
  kind: "formatResponse",
  value: unknown,
): FormatResponse;
export function parseProtocolValue(
  kind: "preDispatchError",
  value: unknown,
): ErrorResponse;
export function parseProtocolValue(
  kind: ProtocolValueKind,
  value: unknown,
): HelperRequest | LocateResponse | FormatResponse {
  switch (kind) {
    case "request":
      return parseRequest(value);
    case "locateResponse":
      return parseLocateResponse(value);
    case "formatResponse":
      return parseFormatResponse(value);
    case "preDispatchError":
      return parseErrorResponse(value, "unknown");
    default:
      return assertNever(kind);
  }
}

export function serializeRequest(request: HelperRequest): Uint8Array {
  const validated = parseRequest(request);
  return new TextEncoder().encode(JSON.stringify(validated));
}
```

- [ ] Compose the equivalent Python constructors. `parse_target`,
  `parse_format_options`, `parse_range`, `parse_edit`, `parse_skip`, and
  `parse_summary` use the primitive validators above and return frozen model objects;
  none retain input dictionaries.

```py
def parse_target(value: object) -> FormatTarget:
    if not isinstance(value, dict):
        raise ProtocolViolation
    mode = value.get("mode")
    if mode == "cursor":
        record = require_exact_dict(
            value,
            frozenset({"mode", "cursor"}),
        )
        return FormatTarget(
            FormatMode.CURSOR,
            cursor=parse_position(record["cursor"]),
        )
    if mode == "selection":
        record = require_exact_dict(
            value,
            frozenset({"mode", "selection"}),
        )
        selection = parse_range(record["selection"], allow_empty=False)
        return FormatTarget(FormatMode.SELECTION, selection=selection)
    record = require_exact_dict(value, frozenset({"mode"}))
    if record["mode"] != "all":
        raise ProtocolViolation
    return FormatTarget(FormatMode.ALL)


def parse_request(value: object) -> HelperRequest:
    record = require_exact_dict(
        value,
        frozenset(
            {"protocolVersion", "operation", "source", "target", "options"}
        ),
    )
    return HelperRequest(
        protocol_version=require_literal(record["protocolVersion"], 1),
        operation=ProtocolOperation(require_enum(record["operation"], {"locate", "format"})),
        source=require_str(record["source"]),
        target=parse_target(record["target"]),
        options=parse_format_options(record["options"]),
    )


def parse_error_response(
    value: object,
    operation: ProtocolOperation | Literal["unknown"],
) -> ErrorResponse:
    record = require_exact_dict(
        value,
        frozenset({"protocolVersion", "operation", "ok", "error"}),
    )
    error = require_exact_dict(record["error"], frozenset({"code"}))
    if record["operation"] != operation or record["ok"] is not False:
        raise ProtocolViolation
    return ErrorResponse(
        protocol_version=require_literal(record["protocolVersion"], 1),
        operation=operation,
        ok=False,
        error=ErrorPayload(ReasonCode(require_reason(error["code"]))),
    )


def parse_edit(value: object) -> FormatEdit:
    record = require_exact_dict(
        value,
        frozenset({"range", "expectedText", "newText"}),
    )
    expected = require_str(record["expectedText"])
    if not expected:
        raise ProtocolViolation
    return FormatEdit(
        parse_range(record["range"], allow_empty=False),
        expected,
        require_str(record["newText"]),
    )


def parse_skip(value: object) -> CandidateSkipPayload:
    record = require_exact_dict(
        value,
        frozenset({"range", "reason"}),
    )
    return CandidateSkipPayload(
        parse_range(record["range"], allow_empty=False),
        ReasonCode(require_reason(record["reason"])),
    )


def parse_summary(value: object) -> FormatSummary:
    record = require_exact_dict(
        value,
        frozenset(
            {"discovered", "selected", "changed", "unchanged", "skipped"}
        ),
    )
    return FormatSummary(
        require_non_negative_int(record["discovered"]),
        require_non_negative_int(record["selected"]),
        require_non_negative_int(record["changed"]),
        require_non_negative_int(record["unchanged"]),
        require_non_negative_int(record["skipped"]),
    )


def parse_locate_response(value: object) -> LocateResponse:
    if isinstance(value, dict) and value.get("ok") is False:
        return parse_error_response(value, ProtocolOperation.LOCATE)
    record = require_exact_dict(
        value,
        frozenset({"protocolVersion", "operation", "ok", "candidates"}),
    )
    if record["operation"] != "locate" or record["ok"] is not True:
        raise ProtocolViolation
    return LocateSuccess(
        require_literal(record["protocolVersion"], 1),
        ProtocolOperation.LOCATE,
        True,
        tuple(
            parse_range(item, allow_empty=False)
            for item in require_list(record["candidates"])
        ),
    )


def parse_format_response(value: object) -> FormatResponse:
    if isinstance(value, dict) and value.get("ok") is False:
        return parse_error_response(value, ProtocolOperation.FORMAT)
    record = require_exact_dict(
        value,
        frozenset(
            {
                "protocolVersion",
                "operation",
                "ok",
                "edits",
                "skips",
                "summary",
            }
        ),
    )
    if record["operation"] != "format" or record["ok"] is not True:
        raise ProtocolViolation
    return FormatSuccess(
        require_literal(record["protocolVersion"], 1),
        ProtocolOperation.FORMAT,
        True,
        tuple(parse_edit(item) for item in require_list(record["edits"])),
        tuple(parse_skip(item) for item in require_list(record["skips"])),
        parse_summary(record["summary"]),
    )


def parse_protocol_value(
    kind: ProtocolValueKind,
    value: object,
) -> HelperRequest | LocateResponse | FormatResponse:
    if kind == "request":
        return parse_request(value)
    if kind == "preDispatchError":
        return parse_error_response(value, "unknown")
    if kind == "locateResponse":
        return parse_locate_response(value)
    if kind == "formatResponse":
        response = parse_format_response(value)
        if isinstance(response, ErrorResponse):
            return response
        validate_ordered_non_overlapping_edits(response)
        return validate_format_relations(response)
    assert_never(kind)
```

- [ ] Implement Python wire conversion explicitly; never serialize dataclasses with
  `asdict()` because snake_case field names differ from the wire contract. Validate
  before encoding, use compact UTF-8 JSON with `allow_nan=False`, and construct
  source-free errors through one helper.

```py
def range_to_wire(value: TextRange) -> dict[str, object]:
    return {
        "start": {
            "line": value.start.line,
            "character": value.start.character,
        },
        "end": {
            "line": value.end.line,
            "character": value.end.character,
        },
    }


def request_to_wire(request: HelperRequest) -> dict[str, object]:
    target: dict[str, object] = {"mode": request.target.mode.value}
    if request.target.cursor is not None:
        target["cursor"] = {
            "line": request.target.cursor.line,
            "character": request.target.cursor.character,
        }
    if request.target.selection is not None:
        target["selection"] = range_to_wire(request.target.selection)
    return {
        "protocolVersion": request.protocol_version,
        "operation": request.operation.value,
        "source": request.source,
        "target": target,
        "options": {
            "keywordCase": request.options.keyword_case,
            "indentWidth": request.options.indent_width,
            "wrapAfter": request.options.wrap_after,
            "useSpaceAroundOperators": (
                request.options.use_space_around_operators
            ),
        },
    }


def response_to_wire(response: HelperResponse) -> dict[str, object]:
    operation = (
        response.operation
        if response.operation == "unknown"
        else response.operation.value
    )
    if isinstance(response, ErrorResponse):
        return {
            "protocolVersion": 1,
            "operation": operation,
            "ok": False,
            "error": {"code": response.error.code.value},
        }
    if isinstance(response, LocateSuccess):
        return {
            "protocolVersion": 1,
            "operation": "locate",
            "ok": True,
            "candidates": [
                range_to_wire(candidate) for candidate in response.candidates
            ],
        }
    return {
        "protocolVersion": 1,
        "operation": "format",
        "ok": True,
        "edits": [
            {
                "range": range_to_wire(edit.range),
                "expectedText": edit.expected_text,
                "newText": edit.new_text,
            }
            for edit in response.edits
        ],
        "skips": [
            {
                "range": range_to_wire(skip.range),
                "reason": skip.reason.value,
            }
            for skip in response.skips
        ],
        "summary": {
            "discovered": response.summary.discovered,
            "selected": response.summary.selected,
            "changed": response.summary.changed,
            "unchanged": response.summary.unchanged,
            "skipped": response.summary.skipped,
        },
    }


def parse_request_json(payload: bytes) -> HelperRequest:
    return parse_request(decode_json(payload))


def serialize_request(request: HelperRequest) -> bytes:
    validated = parse_request(request_to_wire(request))
    return encode_json(request_to_wire(validated))


def serialize_response(response: HelperResponse) -> bytes:
    value = response_to_wire(response)
    kind: ProtocolValueKind = (
        "locateResponse"
        if response.operation == ProtocolOperation.LOCATE
        else "formatResponse"
        if response.operation == ProtocolOperation.FORMAT
        else "preDispatchError"
    )
    parse_protocol_value(kind, value)
    return encode_json(value)


def encode_json(value: object) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ProtocolViolation from error


def error_response(
    operation: ProtocolOperation | Literal["unknown"],
    code: ReasonCode,
) -> ErrorResponse:
    return ErrorResponse(1, operation, False, ErrorPayload(code))
```

- [ ] Enforce relational response invariants after structural parsing in both
  languages. This validation runs before a response is returned to the controller.

```ts
function validateFormatRelations(response: FormatSuccess): FormatSuccess {
  const { summary } = response;
  if (
    response.edits.length !== summary.changed ||
    response.skips.length !== summary.skipped ||
    summary.changed + summary.unchanged + summary.skipped !== summary.selected ||
    summary.selected > summary.discovered
  ) {
    throw new ProtocolViolation();
  }
  return response;
}
```

```py
def validate_format_relations(response: FormatSuccess) -> FormatSuccess:
    summary = response.summary
    if (
        len(response.edits) != summary.changed
        or len(response.skips) != summary.skipped
        or summary.changed + summary.unchanged + summary.skipped
        != summary.selected
        or summary.selected > summary.discovered
    ):
        raise ProtocolViolation
    return response
```

- [ ] Add serializer round-trip tests for all Unicode text, including a non-BMP
  character, without logging payload content.

```ts
test.each(["SELECT '日本語'", "SELECT '𝄞'", "SELECT 'e\u0301'"])(
  "round-trips Unicode without diagnostics containing source",
  (source) => {
    const request: HelperRequest = {
      protocolVersion: 1,
      operation: "locate",
      source,
      target: { mode: "all" },
      options: {
        keywordCase: "upper",
        indentWidth: 2,
        wrapAfter: 88,
        useSpaceAroundOperators: true,
      },
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const encoded = serializeRequest(request);
    const value: unknown = JSON.parse(new TextDecoder().decode(encoded));
    expect(parseProtocolValue("request", value)).toEqual(request);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  },
);
```

```py
@pytest.mark.parametrize("source", ["SELECT '日本語'", "SELECT '𝄞'", "SELECT 'e\u0301'"])
def test_request_json_round_trips_unicode(source: str, capsys: pytest.CaptureFixture[str]) -> None:
    request = HelperRequest(
        protocol_version=1,
        operation=ProtocolOperation.LOCATE,
        source=source,
        target=FormatTarget(mode=FormatMode.ALL),
        options=FormatOptions("upper", 2, 88, True),
    )
    assert parse_request_json(serialize_request(request)) == request
    captured = capsys.readouterr()
    assert source not in captured.out
    assert source not in captured.err
```
- [ ] Run protocol, lint, and type suites.

```bash
bun run test:unit -- test/ts/protocol.test.ts
bun run lint
bun run typecheck
uv run pytest test/python/test_protocol.py -q
uv run ruff check .
uv run ruff format --check .
uv run ty check
```

- [ ] Commit the cross-language contract.

```bash
git add protocol src/constants.ts src/protocol.ts python/inline_sql_helper \
  test/fixtures/helper/protocol-cases.json test/support/helper-fixtures.ts \
  test/ts/protocol.test.ts \
  test/python/test_protocol.py
git commit -m "feat: define strict helper protocol"
```

## Task 4: Build Unicode-safe source position mapping

**Files:**

- Create: `python/inline_sql_helper/positions.py`
- Create: `test/python/test_positions.py`

**Interfaces:**

```py
import re
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from typing import Self

from inline_sql_helper.model import Position, TextRange


class PositionMappingError(ValueError):
    """A source position is outside a representable code-point boundary."""


@dataclass(frozen=True, order=True, slots=True)
class SourceSpan:
    start: int
    end: int
```

The concrete `SourceMap` class has this fixed callable surface:

```text
SourceMap.from_text(text: str) -> SourceMap
SourceMap.offset_from_ast(lineno: int, utf8_col: int) -> int
SourceMap.offset_from_token(row: int, codepoint_col: int) -> int
SourceMap.offset_from_vscode(line: int, utf16_col: int) -> int
SourceMap.vscode_from_offset(offset: int) -> Position
SourceMap.vscode_range(span: SourceSpan) -> TextRange
SourceMap.slice(span: SourceSpan) -> str
SourceMap.vscode_boundaries() -> tuple[int, ...]
```

- [ ] Write table tests for ASCII, CRLF, combining marks, BMP Japanese text, emoji,
  astral mathematical characters, and a literal whose prefix and replacement field
  are surrounded by non-BMP characters. Test every line boundary and reject positions
  inside a UTF-16 surrogate pair or UTF-8 sequence.

```py
@pytest.mark.parametrize(
    ("text", "offset", "expected"),
    [
        ("abc", 3, Position(0, 3)),
        ("日本", 1, Position(0, 1)),
        ("😀x", 1, Position(0, 2)),
        ("e\u0301", 2, Position(0, 2)),
        ("a\r\n😀", 3, Position(1, 0)),
    ],
)
def test_vscode_positions(text: str, offset: int, expected: Position) -> None:
    source_map = SourceMap.from_text(text)
    assert source_map.vscode_from_offset(offset) == expected
    assert source_map.offset_from_vscode(expected.line, expected.character) == offset
```

- [ ] Add a Hypothesis property: every VS Code-representable Python code-point boundary
  round-trips offset → VS Code position → offset for arbitrary text. Add a separate
  parseable-assignment/string strategy for the AST property and prove every AST UTF-8
  column maps to the same source slice as `ast.get_source_segment`; do not feed
  arbitrary unparseable text to the AST property. The offset between `\r` and `\n` in
  a CRLF pair is intentionally absent from `vscode_boundaries()` because VS Code
  exposes the pair as one line break and has no position for that interior offset.

```py
@given(st.text(alphabet=st.characters(blacklist_categories=("Cs",))))
def test_vscode_round_trip(text: str) -> None:
    source_map = SourceMap.from_text(text)
    for offset in source_map.vscode_boundaries():
        position = source_map.vscode_from_offset(offset)
        assert source_map.offset_from_vscode(position.line, position.character) == offset
```

- [ ] Run and confirm failure because `SourceMap` is absent.

```bash
uv run pytest test/python/test_positions.py -q
```

- [ ] Implement immutable spans and precompute each physical line's UTF-8 and UTF-16
  boundary tables. Include a final empty line and distinguish CRLF from lone CR/LF.

```py
@dataclass(frozen=True, order=True, slots=True)
class SourceSpan:
    start: int
    end: int

    def __post_init__(self) -> None:
        if self.start < 0 or self.end < self.start:
            raise ValueError("invalid source span")


@dataclass(frozen=True, slots=True)
class _LineMap:
    start: int
    content_end: int
    next_start: int
    utf8_at_codepoint: tuple[int, ...]
    utf16_at_codepoint: tuple[int, ...]


def _line_map(text: str, start: int, content_end: int, next_start: int) -> _LineMap:
    utf8 = [0]
    utf16 = [0]
    for character in text[start:content_end]:
        utf8.append(utf8[-1] + len(character.encode("utf-8")))
        utf16.append(
            utf16[-1] + len(character.encode("utf-16-le")) // 2
        )
    return _LineMap(start, content_end, next_start, tuple(utf8), tuple(utf16))


def _exact_index(boundaries: tuple[int, ...], value: int) -> int:
    index = bisect_left(boundaries, value)
    if index == len(boundaries) or boundaries[index] != value:
        raise PositionMappingError("column is not a code-point boundary")
    return index


@dataclass(frozen=True, slots=True)
class SourceMap:
    text: str
    lines: tuple[_LineMap, ...]
    line_starts: tuple[int, ...]

    @classmethod
    def from_text(cls, text: str) -> Self:
        lines: list[_LineMap] = []
        start = 0
        for match in re.finditer(r"\r\n|\r|\n", text):
            lines.append(_line_map(text, start, match.start(), match.end()))
            start = match.end()
        lines.append(_line_map(text, start, len(text), len(text)))
        frozen_lines = tuple(lines)
        return cls(
            text=text,
            lines=frozen_lines,
            line_starts=tuple(line.start for line in frozen_lines),
        )

    def _line(self, index: int) -> _LineMap:
        if index < 0 or index >= len(self.lines):
            raise PositionMappingError("line is outside the document")
        return self.lines[index]

    def slice(self, span: SourceSpan) -> str:
        if span.end > len(self.text):
            raise PositionMappingError("span is outside the document")
        return self.text[span.start:span.end]

    def offset_from_ast(self, lineno: int, utf8_col: int) -> int:
        line = self._line(lineno - 1)
        return line.start + _exact_index(line.utf8_at_codepoint, utf8_col)

    def offset_from_token(self, row: int, codepoint_col: int) -> int:
        line = self._line(row - 1)
        maximum = line.next_start - line.start
        if codepoint_col < 0 or codepoint_col > maximum:
            raise PositionMappingError("token column is outside the physical line")
        return line.start + codepoint_col

    def offset_from_vscode(self, line: int, utf16_col: int) -> int:
        record = self._line(line)
        return record.start + _exact_index(
            record.utf16_at_codepoint,
            utf16_col,
        )

    def vscode_from_offset(self, offset: int) -> Position:
        if offset < 0 or offset > len(self.text):
            raise PositionMappingError("offset is outside the document")
        line_index = max(0, bisect_right(self.line_starts, offset) - 1)
        record = self.lines[line_index]
        if offset > record.content_end:
            raise PositionMappingError("offset is inside a line terminator")
        codepoint_col = offset - record.start
        return Position(
            line_index,
            record.utf16_at_codepoint[codepoint_col],
        )

    def vscode_range(self, span: SourceSpan) -> TextRange:
        return TextRange(
            start=self.vscode_from_offset(span.start),
            end=self.vscode_from_offset(span.end),
        )

    def vscode_boundaries(self) -> tuple[int, ...]:
        return tuple(
            offset
            for line in self.lines
            for offset in range(line.start, line.content_end + 1)
        )
```

- [ ] Add exact-boundary lookup and implement AST/tokenize conversions without
  decoding or slicing by byte count. Add these methods inside `SourceMap`.

```py
@pytest.mark.parametrize(
    ("source", "row", "column", "offset"),
    [
        ("x = 1\n", 1, 0, 0),
        ("x = 1\n", 1, 6, 6),
        ("x = 1\r\n", 1, 7, 7),
        ("日本 = 1", 1, 2, 2),
    ],
)
def test_token_columns_include_physical_terminators(
    source: str,
    row: int,
    column: int,
    offset: int,
) -> None:
    assert SourceMap.from_text(source).offset_from_token(row, column) == offset
```

- [ ] Implement strict VS Code conversion, range conversion, slicing, and the
  representable-boundary enumerator. Reject CRLF interior offsets and UTF-16 surrogate
  interiors. Add these methods inside `SourceMap`.

```py
def test_rejects_crlf_and_surrogate_interiors() -> None:
    source_map = SourceMap.from_text("😀\r\nx")
    with pytest.raises(PositionMappingError):
        source_map.offset_from_vscode(0, 1)
    with pytest.raises(PositionMappingError):
        source_map.vscode_from_offset(2)
```
- [ ] Run focused, property, lint, formatting, and type checks.

```bash
uv run pytest test/python/test_positions.py -q
uv run ruff check .
uv run ruff format --check .
uv run ty check
```

- [ ] Commit.

```bash
git add python/inline_sql_helper/positions.py test/python/test_positions.py
git commit -m "feat: map Python and VS Code source positions"
```

## Task 5: Scan plain string tokens and supported literal units

**Files:**

- Create: `python/inline_sql_helper/token_bundles.py`
- Create: `python/inline_sql_helper/literals.py`
- Create: `test/python/test_token_bundles.py`
- Create: `test/python/test_literals.py`

**Interfaces:**

```py
class LiteralKind(StrEnum):
    PLAIN = "plain"
    RAW = "raw"
    FSTRING = "fstring"
    RAW_FSTRING = "raw_fstring"


class UnsupportedStringSyntax(ValueError):
    """The token cannot be split into one supported literal."""


@dataclass(frozen=True, slots=True)
class SourceToken:
    token_type: int
    exact_type: int
    text: str
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class StringTokenBundle:
    kind: Literal["string", "fstring", "tstring"]
    span: SourceSpan
    tokens: tuple[SourceToken, ...]


@dataclass(frozen=True, slots=True)
class SupportedLiteral:
    span: SourceSpan
    content_span: SourceSpan
    prefix: str
    delimiter: Literal["'", '"', "'''", '"""']
    kind: LiteralKind
    field_spans: tuple[SourceSpan, ...]


@dataclass(frozen=True, slots=True)
class UnsupportedLiteral:
    span: SourceSpan
    detection_content_span: SourceSpan | None
    reason: ReasonCode


@dataclass(frozen=True, slots=True)
class DocumentAnalysis:
    source_map: SourceMap
    tree: ast.Module
    supported: tuple[SupportedLiteral, ...]
    unsupported: tuple[UnsupportedLiteral, ...]


def analyze_document(source: str) -> DocumentAnalysis:
    """Parse one complete document and collect plain-string syntax units."""


def tokenize_source(
    source: str,
    source_map: SourceMap,
) -> tuple[SourceToken, ...]:
    """Return source-positioned Python tokens."""


def scan_string_bundles(
    tokens: Sequence[SourceToken],
) -> tuple[StringTokenBundle, ...]:
    """Group top-level plain/f/t string token units."""
```

- [ ] Write tests first for plain/raw case-insensitive prefixes and every delimiter,
  including triple strings with blank boundary lines. Assert exact prefix, delimiter,
  content span, and full span. At this task boundary, only no prefix and `r`/`R`
  become `SupportedLiteral`; f/rf/fr tokens are retained as `fstring` bundles for
  Task 6 but are not counted as supported yet. Add rejection tests for `u`/`U`, bytes,
  t-strings, implicit concatenation, and literals participating in `BinOp(Add)`.
  Valid `u` strings, bytes, and t-strings have no `detection_content_span` and are
  neither candidates nor skips. Invalid prefixes and missing delimiters are instead
  whole-document `DOCUMENT_PARSE_FAILED` cases because `ast.parse` rejects the source
  before literal collection.
  Mark the t-string token-shape assertion for Python 3.14+; on 3.12/3.13 the same source
  belongs to the whole-document invalid-Python test instead.

```py
@pytest.mark.parametrize(
    "prefix",
    ["", "r", "R"],
)
@pytest.mark.parametrize("delimiter", ["'", '"', "'''", '"""'])
def test_supported_prefix_and_delimiter(
    prefix: str,
    delimiter: str,
) -> None:
    source = f"query = {prefix}{delimiter}SELECT 1{delimiter}"
    analysis = analyze_document(source)
    assert len(analysis.supported) == 1
    literal = analysis.supported[0]
    assert literal.prefix == prefix
    assert literal.delimiter == delimiter
```

- [ ] Assert PEP 701 f/rf/fr input is grouped without being prematurely exposed as a
  supported literal. This makes the Task 5 suite green while preserving the exact
  token bundle that Task 6 will promote after field scanning succeeds.

```py
def test_fstring_is_deferred_as_one_bundle() -> None:
    source_map = SourceMap.from_text('query = f"SELECT {value}"')
    bundles = scan_string_bundles(tokenize_source(source_map.text, source_map))
    assert [bundle.kind for bundle in bundles] == ["fstring"]
    assert analyze_document(source_map.text).supported == ()
```
- [ ] Verify a source containing comments, semicolons, multiple statements, and
  non-BMP characters maps each AST `Constant[str]` to exactly one top-level `STRING`
  token. Verify two tokens for one AST node is classified `UNSUPPORTED_LITERAL`.

```py
def test_implicit_concatenation_is_not_a_literal_unit() -> None:
    analysis = analyze_document('query = "SELECT " "1"\n')
    assert analysis.supported == ()
    assert analysis.unsupported[0].reason == ReasonCode.UNSUPPORTED_LITERAL
```

- [ ] Run focused tests and confirm the scanner and collector are missing.

```bash
uv run pytest test/python/test_token_bundles.py test/python/test_literals.py -q
```

- [ ] Implement `tokenize_source()` and `scan_string_bundles()` over Python 3.12
  `tokenize`. Map AST nodes by exact full source span. Split prefix/delimiters from
  source slices rather than evaluated values. Record unsupported units with the range
  used for detection, but never expose their source text in a reason.

```py
def tokenize_source(
    source: str,
    source_map: SourceMap,
) -> tuple[SourceToken, ...]:
    result: list[SourceToken] = []
    for item in tokenize.generate_tokens(io.StringIO(source).readline):
        if item.type == tokenize.ENDMARKER or (
            item.string == ""
            and item.type
            in {
                tokenize.NEWLINE,
                tokenize.NL,
                tokenize.INDENT,
                tokenize.DEDENT,
            }
        ):
            continue
        result.append(
            SourceToken(
                token_type=item.type,
                exact_type=item.exact_type,
                text=item.string,
                span=SourceSpan(
                    source_map.offset_from_token(*item.start),
                    source_map.offset_from_token(*item.end),
                ),
            )
        )
    return tuple(result)


def split_plain_string(source_text: str, span: SourceSpan) -> SupportedLiteral:
    match = re.fullmatch(
        r"(?i:(?P<prefix>r)?)"
        r"(?P<quote>'''|\"\"\"|'|\")"
        r"(?P<body>[\s\S]*)"
        r"(?P=quote)",
        source_text,
    )
    if match is None:
        raise UnsupportedStringSyntax
    prefix = match.group("prefix") or ""
    quote = cast(Literal["'", '"', "'''", '"""'], match.group("quote"))
    content_start = span.start + len(prefix) + len(quote)
    return SupportedLiteral(
        span=span,
        content_span=SourceSpan(content_start, span.end - len(quote)),
        prefix=prefix,
        delimiter=quote,
        kind=LiteralKind.RAW if prefix.casefold() == "r" else LiteralKind.PLAIN,
        field_spans=(),
    )
```

- [ ] Implement bundle grouping as a total, source-ordered tokenizer pass. A plain
  `STRING` token is one bundle. For PEP 701 f-strings and Python 3.14+ t-strings, use
  a stack of matching start/end token kinds so nested f/t strings stay inside their
  owning outer bundle. Missing end tokens are a whole-document parse failure; no
  prefix guessing is allowed.

```py
def _token_constant(name: str) -> int | None:
    value = getattr(token, name, None)
    return value if isinstance(value, int) else None


def scan_string_bundles(
    tokens: Sequence[SourceToken],
) -> tuple[StringTokenBundle, ...]:
    start_to_end = {
        start: end
        for start_name, end_name in (
            ("FSTRING_START", "FSTRING_END"),
            ("TSTRING_START", "TSTRING_END"),
        )
        if (start := _token_constant(start_name)) is not None
        and (end := _token_constant(end_name)) is not None
    }
    fstring_start = _token_constant("FSTRING_START")
    result: list[StringTokenBundle] = []
    index = 0
    while index < len(tokens):
        current = tokens[index]
        if current.token_type == tokenize.STRING:
            result.append(
                StringTokenBundle("string", current.span, (current,))
            )
            index += 1
            continue
        if current.token_type not in start_to_end:
            index += 1
            continue
        start = index
        expected_ends: list[int] = []
        while index < len(tokens):
            item = tokens[index]
            if item.token_type in start_to_end:
                expected_ends.append(start_to_end[item.token_type])
            elif expected_ends and item.token_type == expected_ends[-1]:
                expected_ends.pop()
                if not expected_ends:
                    index += 1
                    break
            index += 1
        if expected_ends:
            raise UnsupportedStringSyntax("unterminated string token bundle")
        grouped = tuple(tokens[start:index])
        kind: Literal["fstring", "tstring"] = (
            "fstring"
            if current.token_type == fstring_start
            else "tstring"
        )
        result.append(
            StringTokenBundle(
                kind,
                SourceSpan(grouped[0].span.start, grouped[-1].span.end),
                grouped,
            )
        )
    return tuple(result)
```

  Add EOF regressions for an empty document, a no-final-newline assignment, an
  indented block ending without a newline, and an f-string at EOF. Assert virtual
  zero-text `NEWLINE`/`NL`/`INDENT`/`DEDENT` tokens are omitted before position
  conversion while every non-empty f-string token remains available to the bundle
  state machine.

- [ ] Add AST visitor state that marks any literal below `BinOp(Add)` unsupported,
  including nested addition. Keep bytes and t-string bundles explicit so they cannot
  be mistaken for supported strings. Keep valid `u`/`U` strings explicit as unsupported
  with no detection span, matching the approved grammar prefix set. Preserve a
  `detection_content_span` for
  implicit-concatenation and `BinOp(Add)` string units; set it to `None` for bytes,
  t-strings, `u` strings, and any unit whose source content boundary is ambiguous.

```py
class StringNodeCollector(ast.NodeVisitor):
    def __init__(self, source_map: SourceMap) -> None:
        self.source_map = source_map
        self.addition_depth = 0
        self.nodes: list[
            tuple[ast.expr, SourceSpan, bool]
        ] = []

    def visit_BinOp(self, node: ast.BinOp) -> None:
        if isinstance(node.op, ast.Add):
            self.addition_depth += 1
            self.visit(node.left)
            self.visit(node.right)
            self.addition_depth -= 1
            return
        self.generic_visit(node)

    def visit_Constant(self, node: ast.Constant) -> None:
        if isinstance(node.value, (str, bytes)):
            self.nodes.append((node, self._span(node), self.addition_depth > 0))

    def visit_JoinedStr(self, node: ast.JoinedStr) -> None:
        self.nodes.append((node, self._span(node), self.addition_depth > 0))

    def visit_TemplateStr(self, node: ast.expr) -> None:
        # Method-name dispatch is version-safe on 3.12/3.13, where the class does
        # not exist. Do not visit its internal Constant nodes separately.
        self.nodes.append((node, self._span(node), self.addition_depth > 0))

    def _span(self, node: ast.expr) -> SourceSpan:
        return SourceSpan(
            self.source_map.offset_from_ast(node.lineno, node.col_offset),
            self.source_map.offset_from_ast(node.end_lineno, node.end_col_offset),
        )
```

- [ ] Compose `analyze_document()` from the scanner and AST collector. Match bundles
  to AST source envelopes, not evaluated values. A one-node/many-bundle match is
  implicit concatenation. A string below `BinOp(Add)` is unsupported even when it has
  one token. For those two classes retain only the first unambiguous string-content
  span for detection; bytes, `u` strings, t-strings, and ambiguous surfaces retain no
  detection span. Task 5 deliberately consumes but does not publish a one-to-one
  f-string bundle; Task 6 promotes it after the field/AST cross-check.

```py
_STRING_SURFACE = re.compile(
    r"(?is)(?P<prefix>[A-Za-z]*)"
    r"(?P<quote>'''|\"\"\"|'|\")"
    r"(?P<body>[\s\S]*)"
    r"(?P=quote)"
)


def _content_span(
    bundle: StringTokenBundle,
    source_map: SourceMap,
) -> tuple[str, str, SourceSpan] | None:
    matched = _STRING_SURFACE.fullmatch(source_map.slice(bundle.span))
    if matched is None:
        return None
    prefix = matched.group("prefix")
    delimiter = matched.group("quote")
    start = bundle.span.start + len(prefix) + len(delimiter)
    return prefix, delimiter, SourceSpan(start, bundle.span.end - len(delimiter))


def _unsupported(
    span: SourceSpan,
    detection_span: SourceSpan | None,
) -> UnsupportedLiteral:
    return UnsupportedLiteral(
        span=span,
        detection_content_span=detection_span,
        reason=ReasonCode.UNSUPPORTED_LITERAL,
    )


def analyze_document(source: str) -> DocumentAnalysis:
    source_map = SourceMap.from_text(source)
    tree = ast.parse(source)
    bundles = scan_string_bundles(tokenize_source(source, source_map))
    collector = StringNodeCollector(source_map)
    collector.visit(tree)
    supported: list[SupportedLiteral] = []
    unsupported: list[UnsupportedLiteral] = []
    consumed: set[int] = set()
    for node, node_span, below_addition in collector.nodes:
        owned = [
            (index, bundle)
            for index, bundle in enumerate(bundles)
            if node_span.start <= bundle.span.start
            and bundle.span.end <= node_span.end
        ]
        consumed.update(index for index, _bundle in owned)
        if isinstance(node, ast.Constant) and isinstance(node.value, bytes):
            unsupported.append(_unsupported(node_span, None))
            continue
        if any(bundle.kind == "tstring" for _index, bundle in owned):
            unsupported.append(_unsupported(node_span, None))
            continue
        surfaces = [
            surface
            for _index, bundle in owned
            if (surface := _content_span(bundle, source_map)) is not None
        ]
        detection_span = surfaces[0][2] if surfaces else None
        if below_addition or len(owned) != 1:
            unsupported.append(_unsupported(node_span, detection_span))
            continue
        bundle = owned[0][1]
        if bundle.kind == "fstring":
            continue
        surface = _content_span(bundle, source_map)
        if surface is None:
            unsupported.append(_unsupported(node_span, None))
            continue
        prefix, _delimiter, _content = surface
        if prefix.casefold() == "u" or "b" in prefix.casefold():
            unsupported.append(_unsupported(node_span, None))
            continue
        try:
            supported.append(
                split_plain_string(source_map.slice(bundle.span), bundle.span)
            )
        except UnsupportedStringSyntax:
            unsupported.append(_unsupported(node_span, None))
    for index, bundle in enumerate(bundles):
        if index not in consumed and bundle.kind == "tstring":
            unsupported.append(_unsupported(bundle.span, None))
    return DocumentAnalysis(
        source_map=source_map,
        tree=tree,
        supported=tuple(sorted(supported, key=lambda item: item.span)),
        unsupported=tuple(sorted(unsupported, key=lambda item: item.span)),
    )
```

- [ ] Add boundary tests for the concrete collector: zero strings, several independent
  literals, nested AST containers, a bytes-only document, a 3.14 t-string-only
  document, one f-string deferred exactly once, and implicit concatenation whose
  detection span is the first literal body. Assert every bundle is consumed at most
  once and output spans are strictly source ordered.

- [ ] Run focused tests and Python quality checks.

```bash
uv run pytest test/python/test_token_bundles.py test/python/test_literals.py -q
uv run ruff check .
uv run ruff format --check .
uv run ty check
```

- [ ] Commit.

```bash
git add python/inline_sql_helper/token_bundles.py \
  python/inline_sql_helper/literals.py test/python/test_token_bundles.py \
  test/python/test_literals.py
git commit -m "feat: identify standalone Python string literals"
```

## Task 6: Parse PEP 701 f-string bundles and replacement-field spans

**Files:**

- Modify: `python/inline_sql_helper/token_bundles.py`
- Modify: `python/inline_sql_helper/literals.py`
- Modify: `test/python/test_token_bundles.py`
- Modify: `test/python/test_literals.py`
- Create: `test/python/test_fstring_properties.py`

**Interfaces:**

```py
class UnsafeFieldScan(ValueError):
    """A source-free failure to identify exact f-string fields."""


def scan_fstring_field_spans(
    bundle: StringTokenBundle,
    source_map: SourceMap,
) -> tuple[SourceSpan, ...]:
    """Return complete top-level replacement fields, including braces."""
```

- [ ] Define the test-only helpers used by the examples. `only()` rejects zero/multiple
  values. The Hypothesis strategy emits a finite grammar of valid PEP 701 fields,
  including conversions, debug syntax, indexing, nested format specs, and doubled
  braces. The assertion reparses independently and compares exact source envelopes; no
  helper is left as a symbolic name.

```py
T = TypeVar("T")


def only(values: Sequence[T]) -> T:
    assert len(values) == 1
    return values[0]


@st.composite
def valid_fstring_sources(draw: st.DrawFn) -> str:
    field = draw(
        st.sampled_from(
            [
                "{value}",
                "{value=}",
                "{value!r}",
                "{items[key]}",
                "{value:>{width}}",
                "{(lambda item: item)(value)}",
            ]
        )
    )
    left = draw(st.sampled_from(["SELECT ", "SELECT {{literal}}, "]))
    right = draw(st.sampled_from(["", " FROM table", " -- tail"]))
    return f'query = f"""{left}{field}{right}"""'


def assert_fields_match_formatted_values(
    source: str,
    spans: tuple[SourceSpan, ...],
) -> None:
    source_map = SourceMap.from_text(source)
    tree = ast.parse(source)
    assignment = only(tuple(node for node in tree.body if isinstance(node, ast.Assign)))
    assert isinstance(assignment.value, ast.JoinedStr)
    joined = assignment.value
    expected = direct_ast_field_spans(joined, source_map)
    assert spans == expected
    assert all(
        left.end <= right.start
        for left, right in itertools.pairwise(spans)
    )
    for span in spans:
        assert source_map.slice(span).startswith("{")
        assert source_map.slice(span).endswith("}")
```

- [ ] Add failing examples for simple fields, debug `=`, `!s`, `!r`, `!a`, nested
  format specs, dictionary/index braces, lambda, multiline expressions, expression
  comments, same-quote strings, nested f-strings, multiple fields, and adjacent
  `{{`/`}}`. Assert each returned span is the exact original `{` through matching `}`.

```py
@pytest.mark.parametrize(
    ("literal_source", "fields"),
    [
        ('f"SELECT {value}"', ("{value}",)),
        ('f"SELECT {value=}"', ("{value=}",)),
        ('f"SELECT {value!s}"', ("{value!s}",)),
        ('f"SELECT {value!r:>{width}}"', ("{value!r:>{width}}",)),
        ('f"SELECT {value!a}"', ("{value!a}",)),
        ('f"SELECT {{x}}, {items[{key}]}"', ("{items[{key}]}",)),
        ('f"""SELECT {(\nvalue\n)}"""', ("{(\nvalue\n)}",)),
        ('f"""SELECT {value  # expression comment\n}"""', (
            "{value  # expression comment\n}",
        )),
        ('f"SELECT {mapping["key"]}"', ('{mapping["key"]}',)),
        ('f"SELECT {f"{value}"}"', ('{f"{value}"}',)),
        ('f"SELECT {left}, {right}"', ("{left}", "{right}")),
    ],
)
def test_exact_top_level_field_spans(
    literal_source: str,
    fields: tuple[str, ...],
) -> None:
    source = f"query = {literal_source}"
    analysis = analyze_document(source)
    literal = analysis.supported[0]
    assert tuple(analysis.source_map.slice(span) for span in literal.field_spans) == fields
```

- [ ] Move the final supported-prefix matrix here: f/rf/fr in every case combination
  and all four delimiters must now produce `FSTRING` or `RAW_FSTRING`. Re-run the
  Task 5 plain/raw matrix unchanged so promotion cannot regress ordinary literals.

```py
@pytest.mark.parametrize(
    "prefix",
    ["f", "F", "rf", "rF", "Rf", "RF", "fr", "fR", "Fr", "FR"],
)
@pytest.mark.parametrize("delimiter", ["'", '"', "'''", '"""'])
def test_supported_fstring_prefix_and_delimiter(
    prefix: str,
    delimiter: str,
) -> None:
    analysis = analyze_document(
        f"query = {prefix}{delimiter}SELECT {{value}}{delimiter}"
    )
    literal = only(analysis.supported)
    assert literal.prefix == prefix
    assert literal.delimiter == delimiter
    assert literal.kind is (
        LiteralKind.FSTRING
        if prefix.casefold() == "f"
        else LiteralKind.RAW_FSTRING
    )
```
- [ ] Add a property strategy built from a finite grammar of valid Python 3.12
  replacement fields. For every generated f-string, assert field spans are ordered,
  non-overlapping, parseable, and equal to the corresponding AST `FormattedValue`
  source envelope.

```py
@given(valid_fstring_sources())
def test_scanned_fields_agree_with_ast(source: str) -> None:
    analysis = analyze_document(source)
    literal = only(analysis.supported)
    assert_fields_match_formatted_values(source, literal.field_spans)
```

- [ ] Run with Python 3.12 and confirm failures for missing bundle state handling.

```bash
uv run --python 3.12 pytest \
  test/python/test_token_bundles.py \
  test/python/test_literals.py \
  test/python/test_fstring_properties.py -q
```

- [ ] Implement a top-level `FSTRING_START` → matching `FSTRING_END` state machine.
  Track replacement-field brace depth, conversion, format spec, nested replacement
  fields, and nested f-string tokens. Treat doubled braces as literal content.

```py
def scan_fstring_field_spans(
    bundle: StringTokenBundle,
    source_map: SourceMap,
) -> tuple[SourceSpan, ...]:
    del source_map
    fields: list[SourceSpan] = []
    field_start: int | None = None
    closers: list[int] = []
    fstring_depth = 0
    opening = {
        token.LPAR: token.RPAR,
        token.LSQB: token.RSQB,
        token.LBRACE: token.RBRACE,
    }
    for item in bundle.tokens:
        if item.token_type == token.FSTRING_START:
            fstring_depth += 1
            continue
        if item.token_type == token.FSTRING_END:
            fstring_depth -= 1
            continue
        if field_start is None:
            if fstring_depth == 1 and item.exact_type == token.LBRACE:
                field_start = item.span.start
                closers = [token.RBRACE]
            continue
        expected = opening.get(item.exact_type)
        if expected is not None:
            closers.append(expected)
        elif item.exact_type in {token.RPAR, token.RSQB, token.RBRACE}:
            if not closers or item.exact_type != closers.pop():
                raise UnsafeFieldScan("unbalanced replacement field")
            if not closers:
                fields.append(SourceSpan(field_start, item.span.end))
                field_start = None
    if field_start is not None or fstring_depth != 0:
        raise UnsafeFieldScan("unterminated f-string field")
    return tuple(fields)
```

- [ ] Extend Task 5's `analyze_document()` so supported f-string bundles become
  `FSTRING` or `RAW_FSTRING` literals while the existing plain-string behavior and
  unsupported classifications remain unchanged.

```py
def fstring_kind(prefix: str) -> LiteralKind:
    normalized = prefix.casefold()
    if normalized == "f":
        return LiteralKind.FSTRING
    if normalized in {"rf", "fr"}:
        return LiteralKind.RAW_FSTRING
    raise UnsupportedStringSyntax
```

- [ ] Cross-check scanner spans with the AST. If there is no one-to-one,
  source-ordered match with `FormattedValue` nodes, classify the whole literal as
  `UNSAFE_FSTRING_RESTORE`; never guess a field boundary.

```py
def direct_ast_field_spans(
    node: ast.JoinedStr,
    source_map: SourceMap,
) -> tuple[SourceSpan, ...]:
    return tuple(
        SourceSpan(
            source_map.offset_from_ast(value.lineno, value.col_offset),
            source_map.offset_from_ast(value.end_lineno, value.end_col_offset),
        )
        for value in node.values
        if isinstance(value, ast.FormattedValue)
    )


def checked_field_spans(
    node: ast.JoinedStr,
    scanned: tuple[SourceSpan, ...],
    source_map: SourceMap,
) -> tuple[SourceSpan, ...]:
    if direct_ast_field_spans(node, source_map) != scanned:
        raise UnsafeFieldScan("AST and token field spans differ")
    return scanned
```

- [ ] Add the concrete Task 6 promotion path and replace Task 5's
  `if bundle.kind == "fstring": continue` branch with it. The promotion requires one
  `ast.JoinedStr`, one f-string bundle, a supported case-insensitive prefix, an exact
  surface split, and identical token/AST field envelopes. A failed field cross-check
  remains detectable but becomes an `UNSAFE_FSTRING_RESTORE` candidate skip; malformed
  or unsupported prefixes remain `UNSUPPORTED_LITERAL` with no guessed content range.

```py
def classify_fstring(
    node: ast.expr,
    bundle: StringTokenBundle,
    source_map: SourceMap,
) -> SupportedLiteral | UnsupportedLiteral:
    surface = _content_span(bundle, source_map)
    if surface is None or not isinstance(node, ast.JoinedStr):
        return _unsupported(bundle.span, None)
    prefix, delimiter, content_span = surface
    try:
        kind = fstring_kind(prefix)
        scanned = scan_fstring_field_spans(bundle, source_map)
        fields = checked_field_spans(node, scanned, source_map)
    except UnsupportedStringSyntax:
        return _unsupported(bundle.span, None)
    except UnsafeFieldScan:
        return UnsupportedLiteral(
            span=bundle.span,
            detection_content_span=content_span,
            reason=ReasonCode.UNSAFE_FSTRING_RESTORE,
        )
    return SupportedLiteral(
        span=bundle.span,
        content_span=content_span,
        prefix=prefix,
        delimiter=cast(
            Literal["'", '"', "'''", '"""'],
            delimiter,
        ),
        kind=kind,
        field_spans=fields,
    )
```

The corresponding branch inside `analyze_document()` is explicit:

```py
if bundle.kind == "fstring":
    classified = classify_fstring(node, bundle, source_map)
    if isinstance(classified, SupportedLiteral):
        supported.append(classified)
    else:
        unsupported.append(classified)
    continue
```

- [ ] Add regression tests for every promotion precondition: non-`JoinedStr` mismatch,
  surface mismatch, unsupported prefix, scanner failure, AST-envelope mismatch,
  successful empty-field f-string, and successful multiple-field f-string. Assert
  failure paths create exactly one skip unit, never a partially supported literal.
  On Python 3.14, assert `t"SELECT 1"` is represented by exactly one
  `UnsupportedLiteral`, with no nested `Constant` duplicate and no detection span.

- [ ] Run on Python 3.12, 3.13, and 3.14. Python-version-specific t-string tokens must
  remain unsupported and must not alter f-string behavior. Read their token constants
  through `getattr` because Python 3.12/3.13 do not define those names.

```py
TSTRING_TYPES = frozenset(
    value
    for name in ("TSTRING_START", "TSTRING_MIDDLE", "TSTRING_END")
    if (value := getattr(token, name, None)) is not None
)
```

```bash
for version in 3.12 3.13 3.14; do
  uv run --python "$version" pytest \
    test/python/test_token_bundles.py \
    test/python/test_literals.py \
    test/python/test_fstring_properties.py -q
done
uv run ruff check .
uv run ruff format --check .
uv run ty check
```

- [ ] Commit.

```bash
git add python/inline_sql_helper/token_bundles.py \
  python/inline_sql_helper/literals.py test/python/test_token_bundles.py \
  test/python/test_literals.py test/python/test_fstring_properties.py
git commit -m "feat: preserve PEP 701 f-string field boundaries"
```

## Task 7: Implement source-level SQL candidate detection

**Files:**

- Create: `python/inline_sql_helper/detection.py`
- Create: `test/python/test_detection.py`
- Read: `test/fixtures/sql-detection.json`

**Interfaces:**

```py
@dataclass(frozen=True, slots=True)
class SqlDetection:
    matched: bool
    marker_span: SourceSpan | None
    sql_span: SourceSpan | None
    reason: Literal["marker", "keyword", "none"]


def detect_sql(
    literal: SupportedLiteral | UnsupportedLiteral,
    source_map: SourceMap,
) -> SqlDetection:
    """Detect SQL from physical source characters without evaluating escapes."""
```

- [ ] Parameterize Python tests directly from `sql-detection.json`; do not copy the
  matrix into Python. For parseable supported literals, assert
  `formatExpectation="supported"` implies `detectionExpected=true` and
  `grammarExpectation="sql"`, and every supported positive fixture reports the exact
  SQL content span. Invalid/incomplete fixtures must produce request-level parse
  failure rather than a detection result.

```py
@dataclass(frozen=True, slots=True)
class DetectionCase:
    id: str
    kind: Literal["content", "source"]
    content: str | None
    source: str | None
    detection_expected: bool
    format_expectation: Literal[
        "supported",
        "unsupported-skip",
        "ignored",
        "parse-error",
    ]


def load_detection_cases() -> tuple[DetectionCase, ...]:
    raw = json.loads(
        Path("test/fixtures/sql-detection.json").read_text(encoding="utf-8")
    )
    runtime_key = f"{sys.version_info.major}.{sys.version_info.minor}"
    cases: list[DetectionCase] = []
    for item in raw:
        overrides = item.get("formatExpectationByPython", {})
        assert set(overrides).issubset({"3.12", "3.13", "3.14"})
        expectation = overrides.get(runtime_key, item["formatExpectation"])
        cases.append(
            DetectionCase(
                id=item["id"],
                kind=item["kind"],
                content=item.get("content"),
                source=item.get("source"),
                detection_expected=item["detectionExpected"],
                format_expectation=expectation,
            )
        )
    return tuple(cases)


@pytest.mark.parametrize("case", load_detection_cases(), ids=lambda case: case.id)
def test_shared_detection_case(case: DetectionCase) -> None:
    source = (
        'query = """' + cast(str, case.content) + '"""'
        if case.kind == "content"
        else cast(str, case.source)
    )
    try:
        analysis = analyze_document(source)
    except (SyntaxError, tokenize.TokenError):
        assert case.format_expectation == "parse-error"
        return
    if case.format_expectation == "parse-error":
        pytest.fail("fixture expected a request-level parse failure")
    units = (*analysis.supported, *analysis.unsupported)
    matches = [
        literal
        for literal in units
        if detect_sql(literal, analysis.source_map).matched
    ]
    assert bool(matches) is case.detection_expected
    if case.format_expectation == "supported":
        assert any(isinstance(item, SupportedLiteral) for item in matches)
    elif case.format_expectation == "unsupported-skip":
        assert matches
        assert all(isinstance(item, UnsupportedLiteral) for item in matches)
    elif case.format_expectation == "ignored":
        assert matches == []
```

- [ ] For an `UnsupportedLiteral`, inspect only its optional
  `detection_content_span`. Implicit concatenation and string literals participating in
  `BinOp(Add)` retain a source-level detection span and can become an
  `UNSUPPORTED_LITERAL` skip. Bytes, t-strings, and shapes without an unambiguous string
  content span set it to `None` and never become SQL candidates.

```py
def test_unsupported_detection_never_changes_support_status() -> None:
    analysis = analyze_document('query = "SELECT " "1"')
    literal = analysis.unsupported[0]
    assert detect_sql(literal, analysis.source_map).matched is True
    assert analysis.supported == ()
```

- [ ] Add boundary tests for `-- sql` and `--sql` with case and horizontal whitespace,
  leading physical blank lines, CRLF, a marker without SQL tokens, and a marker
  followed by SQL comments. Include lone CR. Assert marker source is excluded from
  `sql_span`.

```py
def parse_only_literal(source: str) -> tuple[SupportedLiteral, SourceMap]:
    analysis = analyze_document(source)
    assert len(analysis.supported) == 1
    return analysis.supported[0], analysis.source_map


@pytest.mark.parametrize(
    ("content", "matched"),
    [
        ("--sql\rSELECT 1", True),
        ("\n \t-- SQL \r\nSELECT 1", True),
        ("--  sql\nSELECT 1", False),
        ("--\tsql\nSELECT 1", False),
    ],
)
def test_marker_boundaries(content: str, matched: bool) -> None:
    literal, source_map = parse_only_literal(
        'query = """' + content + '"""',
    )
    assert detect_sql(literal, source_map).matched is matched
```
- [ ] Add keyword tests for all eleven words, ASCII word boundary, Unicode identifier
  continuation, literal backslash escapes, comments before keyword, and prose.

```py
def test_escape_spelling_is_not_physical_whitespace() -> None:
    literal, source_map = parse_only_literal(r'query = r"\nSELECT 1"')
    assert detect_sql(literal, source_map).matched is False
```

- [ ] Run the test and confirm it fails before creating the detector.

```bash
uv run pytest test/python/test_detection.py -q
```

- [ ] Implement only the two approved rules. Use source slices and an explicit
  ASCII whitespace set; do not call `ast.literal_eval`, decode escapes, inspect call
  names, or add configurable keywords. Detection never makes an unsupported unit
  formattable; it only gives the engine enough information to return a precise skip.

```py
_MARKERS = frozenset({"-- sql", "--sql"})
_KEYWORDS = (
    "select",
    "with",
    "insert",
    "update",
    "delete",
    "merge",
    "create",
    "alter",
    "drop",
    "truncate",
    "explain",
)
_ASCII_WHITESPACE = frozenset(" \t\r\n")


def _continues_identifier(character: str) -> bool:
    return bool(character) and (
        character == "_" or ("A" + character).isidentifier()
    )


def _detect_source_slice(text: str, base: int) -> SqlDetection:
    cursor = 0
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\r\n")
        if body.strip(" \t") == "":
            cursor += len(line)
            continue
        if body.strip(" \t").casefold() in _MARKERS:
            marker = SourceSpan(base + cursor, base + cursor + len(body))
            return SqlDetection(
                True,
                marker,
                SourceSpan(base + cursor + len(line), base + len(text)),
                "marker",
            )
        break
    significant = 0
    while significant < len(text) and text[significant] in _ASCII_WHITESPACE:
        significant += 1
    folded = text[significant:].casefold()
    for keyword in _KEYWORDS:
        if not folded.startswith(keyword):
            continue
        following = text[
            significant + len(keyword) : significant + len(keyword) + 1
        ]
        if not _continues_identifier(following):
            return SqlDetection(
                True,
                None,
                SourceSpan(base + significant, base + len(text)),
                "keyword",
            )
    return SqlDetection(False, None, None, "none")


def detect_sql(
    literal: SupportedLiteral | UnsupportedLiteral,
    source_map: SourceMap,
) -> SqlDetection:
    span = (
        literal.content_span
        if isinstance(literal, SupportedLiteral)
        else literal.detection_content_span
    )
    if span is None:
        return SqlDetection(False, None, None, "none")
    return _detect_source_slice(source_map.slice(span), span.start)
```
- [ ] Run Python detection and TypeScript grammar parity together.

```bash
uv run pytest test/python/test_detection.py -q
VSCODE_TEST_VERSION=1.95.0 bun run test:grammar -- detection-parity
VSCODE_TEST_VERSION=stable bun run test:grammar -- detection-parity
uv run ruff check .
uv run ruff format --check .
uv run ty check
```

- [ ] Commit.

```bash
git add python/inline_sql_helper/detection.py test/python/test_detection.py
git commit -m "feat: detect inline SQL from source text"
```

## Task 8: Protect and exactly restore f-string and Python source regions

**Files:**

- Create: `python/inline_sql_helper/protection.py`
- Create: `test/python/test_protection.py`

**Interfaces:**

```py
class ProtectedKind(StrEnum):
    FIELD = "field"
    ESCAPED_BRACE = "escaped_brace"
    PYTHON_ESCAPE = "python_escape"
    SQL_MARKER = "sql_marker"


class UnsafeRestore(ValueError):
    """A source-free failure to restore protected Python text."""


@dataclass(frozen=True, slots=True)
class ProtectedFragment:
    kind: ProtectedKind
    ordinal: int
    source_span: SourceSpan
    source_text: str
    marker: str
    required_offset: int | None


@dataclass(frozen=True, slots=True)
class ProtectionPlan:
    nonce: str
    protected_sql: str
    fragments: tuple[ProtectedFragment, ...]


def allocate_nonce(source: str, random_bytes: Callable[[int], bytes]) -> str:
    """Return a marker nonce absent from the complete source."""


def build_protection_plan(
    source_map: SourceMap,
    literal: SupportedLiteral,
    detection: SqlDetection,
    nonce: str,
) -> ProtectionPlan:
    """Mask exact source spans before SQL formatting."""


def restore_protected(formatted: str, plan: ProtectionPlan) -> str:
    """Restore every fragment once, in kind and ordinal order."""
```

- [ ] Add failing tests for nonce collisions in the full document and candidate,
  deterministic collision retries, marker order swaps, duplicate markers, missing
  markers, extra markers, marker text embedded into SQL strings/comments, debug and
  conversion fields, nested specs, doubled braces, normal-string escape sequences,
  raw strings, and explicit SQL markers. Add byte-for-byte cases for `--sql\r\n`,
  ` -- SQL \n`, and a marker on the final line without a terminator.

```py
def protection_plan_for(
    source: str,
    nonce: str = "11" * 16,
) -> ProtectionPlan:
    analysis = analyze_document(source)
    literal = analysis.supported[0]
    detection = detect_sql(literal, analysis.source_map)
    return build_protection_plan(
        analysis.source_map,
        literal,
        detection,
        nonce,
    )


def test_nonce_retries_collision_and_marker_crlf_is_exact() -> None:
    random_values = iter([bytes(16), b"\x01" * 16])
    nonce = allocate_nonce(
        "prefix-" + bytes(16).hex(),
        lambda size: next(random_values),
    )
    assert nonce == (b"\x01" * 16).hex()
    plan = protection_plan_for('query = """--sql\r\nselect 1"""', nonce)
    restored = restore_protected(plan.protected_sql, plan)
    assert restored.startswith("--sql\r\n")
```

- [ ] Assert fragment `source_text` is obtained from the original source span and that
  a restore failure raises a typed candidate-level exception whose rendered message
  contains neither fragment text nor SQL text.

```py
def test_reordered_markers_are_rejected() -> None:
    plan = protection_plan_for('query = f"SELECT {left}, {right}"')
    reordered = plan.protected_sql.replace(plan.fragments[0].marker, "SWAP", 1)
    reordered = reordered.replace(plan.fragments[1].marker, plan.fragments[0].marker, 1)
    reordered = reordered.replace("SWAP", plan.fragments[1].marker, 1)
    with pytest.raises(UnsafeRestore):
        restore_protected(reordered, plan)
```

- [ ] Run and confirm the module is missing.

```bash
uv run pytest test/python/test_protection.py -q
```

- [ ] Implement collision-free cryptographic nonces and markers containing nonce,
  ordinal, and kind. Protect complete replacement fields, doubled braces, normal
  Python escapes, and the complete marker line including its physical line terminator.
  The SQL-marker fragment starts at content offset 0 and covers every leading blank
  line plus the marker line. Replace a fragment ending in CRLF/LF/CR with one nonce
  SQL-comment marker plus canonical `\n`, so sqlparse retains one layout boundary;
  replace a final unterminated marker with the nonce marker alone. Set that fragment's
  `required_offset` to 0 and every other fragment's value to `None`. Restore the
  canonical fragment to the byte-for-byte original leading blanks, marker line, and
  terminator. Sort spans and reject overlap before masking.
  `build_protection_plan()` consumes a request-owned nonce and never allocates another
  nonce itself.

```py
def allocate_nonce(
    source: str,
    random_bytes: Callable[[int], bytes],
) -> str:
    for _attempt in range(128):
        nonce = random_bytes(16).hex()
        if nonce not in source:
            return nonce
    raise UnsafeRestore("unable to allocate protection nonce")


def marker_text(
    nonce: str,
    kind: ProtectedKind,
    ordinal: int,
    *,
    sql_comment: bool,
    canonical_newline: bool,
) -> str:
    token = f"__INLINE_SQL_{nonce}_{kind.name}_{ordinal}__"
    return ("-- " if sql_comment else "") + token + (
        "\n" if canonical_newline else ""
    )


def mask_fragments(
    content: str,
    content_start: int,
    fragments: Sequence[ProtectedFragment],
) -> str:
    pieces: list[str] = []
    cursor = 0
    for fragment in fragments:
        start = fragment.source_span.start - content_start
        end = fragment.source_span.end - content_start
        if start < cursor or end < start:
            raise UnsafeRestore("protected source spans overlap")
        pieces.extend((content[cursor:start], fragment.marker))
        cursor = end
    pieces.append(content[cursor:])
    return "".join(pieces)
```

- [ ] Build the fragment list from exact source spans. Derive the explicit-marker
  fragment as `literal.content_span.start:detection.sql_span.start`; this is what
  includes leading physical blank lines, marker trailing whitespace, and its original
  line terminator. Scan only uncovered literal content for doubled braces and, for
  non-raw literals, Python escape spellings. Escape scanning consumes line
  continuations, named Unicode escapes, fixed-width hex/Unicode escapes, octal escapes,
  or one escaped code point. Since the document already parsed, an incomplete escape
  is a typed restore failure rather than a guessed span.

```py
@dataclass(frozen=True, slots=True)
class _FragmentSpec:
    kind: ProtectedKind
    source_span: SourceSpan
    sql_comment: bool = False
    canonical_newline: bool = False
    required_offset: int | None = None


def _intersects_any(span: SourceSpan, blocked: Sequence[SourceSpan]) -> bool:
    return any(
        span.start < other.end and other.start < span.end
        for other in blocked
    )


def _python_escape_end(source: str, start: int, limit: int) -> int:
    if start + 1 >= limit or source[start] != "\\":
        raise UnsafeRestore("invalid Python escape boundary")
    next_character = source[start + 1]
    if next_character == "\r" and start + 2 < limit and source[start + 2] == "\n":
        return start + 3
    if next_character in "\r\n":
        return start + 2
    if next_character == "N" and start + 2 < limit and source[start + 2] == "{":
        close = source.find("}", start + 3, limit)
        if close < 0:
            raise UnsafeRestore("unterminated named Python escape")
        return close + 1
    widths = {"x": 2, "u": 4, "U": 8}
    if next_character in widths:
        end = start + 2 + widths[next_character]
        if end > limit:
            raise UnsafeRestore("unterminated fixed-width Python escape")
        return end
    if next_character in "01234567":
        end = start + 2
        while end < min(start + 4, limit) and source[end] in "01234567":
            end += 1
        return end
    return start + 2


def _discover_source_specs(
    source_map: SourceMap,
    literal: SupportedLiteral,
    detection: SqlDetection,
) -> tuple[_FragmentSpec, ...]:
    content = literal.content_span
    specs: list[_FragmentSpec] = []
    if detection.marker_span is not None:
        if detection.sql_span is None:
            raise UnsafeRestore("marker detection has no SQL boundary")
        marker_span = SourceSpan(content.start, detection.sql_span.start)
        marker_source = source_map.slice(marker_span)
        specs.append(
            _FragmentSpec(
                ProtectedKind.SQL_MARKER,
                marker_span,
                sql_comment=True,
                canonical_newline=marker_source.endswith(("\r", "\n")),
                required_offset=0,
            )
        )
    specs.extend(
        _FragmentSpec(ProtectedKind.FIELD, span)
        for span in literal.field_spans
    )
    fixed_spans = [spec.source_span for spec in specs]
    if literal.kind not in {LiteralKind.RAW, LiteralKind.RAW_FSTRING}:
        cursor = content.start
        while cursor < content.end:
            if source_map.text[cursor] != "\\":
                cursor += 1
                continue
            end = _python_escape_end(source_map.text, cursor, content.end)
            span = SourceSpan(cursor, end)
            if not _intersects_any(span, fixed_spans):
                specs.append(_FragmentSpec(ProtectedKind.PYTHON_ESCAPE, span))
            cursor = end
    cursor = content.start
    while cursor + 1 < content.end:
        pair = source_map.text[cursor : cursor + 2]
        span = SourceSpan(cursor, cursor + 2)
        if pair not in {"{{", "}}"}:
            cursor += 1
            continue
        overlaps = [
            spec
            for spec in specs
            if _intersects_any(span, (spec.source_span,))
        ]
        if not overlaps:
            specs.append(_FragmentSpec(ProtectedKind.ESCAPED_BRACE, span))
        elif all(
            spec.kind is ProtectedKind.PYTHON_ESCAPE for spec in overlaps
        ):
            # `f"\{{"` and `f"\}}"` are one indivisible source fragment:
            # masking only the doubled brace would leave the Python escape mutable.
            merged = SourceSpan(
                min(span.start, *(spec.source_span.start for spec in overlaps)),
                max(span.end, *(spec.source_span.end for spec in overlaps)),
            )
            specs = [spec for spec in specs if spec not in overlaps]
            specs.append(
                _FragmentSpec(ProtectedKind.PYTHON_ESCAPE, merged)
            )
        cursor += 2
    return tuple(sorted(specs, key=lambda item: item.source_span))


def build_protection_plan(
    source_map: SourceMap,
    literal: SupportedLiteral,
    detection: SqlDetection,
    nonce: str,
) -> ProtectionPlan:
    if (
        not detection.matched
        or detection.sql_span is None
        or not re.fullmatch(r"[0-9a-f]{32}", nonce)
        or nonce in source_map.text
    ):
        raise UnsafeRestore("invalid protection-plan input")
    specs = _discover_source_specs(source_map, literal, detection)
    fragments: list[ProtectedFragment] = []
    previous_end = literal.content_span.start
    for ordinal, spec in enumerate(specs):
        span = spec.source_span
        if (
            span.start < previous_end
            or span.start < literal.content_span.start
            or span.end > literal.content_span.end
        ):
            raise UnsafeRestore("protected source spans overlap")
        fragments.append(
            ProtectedFragment(
                kind=spec.kind,
                ordinal=ordinal,
                source_span=span,
                source_text=source_map.slice(span),
                marker=marker_text(
                    nonce,
                    spec.kind,
                    ordinal,
                    sql_comment=spec.sql_comment,
                    canonical_newline=spec.canonical_newline,
                ),
                required_offset=spec.required_offset,
            )
        )
        previous_end = span.end
    frozen = tuple(fragments)
    return ProtectionPlan(
        nonce=nonce,
        protected_sql=mask_fragments(
            source_map.slice(literal.content_span),
            literal.content_span.start,
            frozen,
        ),
        fragments=frozen,
    )
```

- [ ] Add construction tests that assert the exact ordered `(kind, source_span,
  source_text, marker, required_offset)` tuple for a candidate containing all four
  fragment kinds. Assert raw/rf/fr candidates omit `PYTHON_ESCAPE`, normal/f candidates
  include it, braces inside a replacement field are not double-counted, SQL-marker
  CRLF is represented by one canonical marker newline, and every fragment span lies
  within the literal content span. Include valid normal f-string sources whose content
  contains `\{{` and `\}}`; each overlap must become one union
  `PYTHON_ESCAPE` fragment covering the backslash and both braces, restore
  byte-for-byte, and remain idempotent after formatting.

- [ ] Restore by a single ordered scan. Verify exact marker count, order, kind,
  ordinal, plan nonce, canonical marker-line newline, and original source text. Require
  every non-`None` `required_offset` exactly, so sqlparse cannot move the explicit SQL
  marker before restoration. Reject any extra token carrying the plan nonce. Do not use
  global replacements that can hide duplicates or reordering.

```py
def _marker_token(marker: str, nonce: str) -> str:
    match = re.search(
        rf"__INLINE_SQL_{re.escape(nonce)}_[A-Z_]+_[0-9]+__",
        marker,
    )
    if match is None:
        raise UnsafeRestore("invalid protected marker")
    return match.group(0)


def restore_protected(formatted: str, plan: ProtectionPlan) -> str:
    if formatted.count(plan.nonce) != len(plan.fragments):
        raise UnsafeRestore("protection namespace count changed")
    namespace = re.compile(
        rf"__INLINE_SQL_{re.escape(plan.nonce)}_[A-Z_]+_[0-9]+__"
    )
    actual_tokens = tuple(match.group(0) for match in namespace.finditer(formatted))
    expected_tokens = tuple(
        _marker_token(fragment.marker, plan.nonce)
        for fragment in plan.fragments
    )
    if actual_tokens != expected_tokens:
        raise UnsafeRestore("protected marker sequence changed")
    pieces: list[str] = []
    cursor = 0
    for fragment in plan.fragments:
        position = formatted.find(fragment.marker, cursor)
        if position < 0:
            raise UnsafeRestore("protected marker spelling changed")
        if fragment.required_offset is not None and position != fragment.required_offset:
            raise UnsafeRestore("anchored marker moved")
        pieces.extend((formatted[cursor:position], fragment.source_text))
        cursor = position + len(fragment.marker)
    pieces.append(formatted[cursor:])
    restored = "".join(pieces)
    if plan.nonce in restored:
        raise UnsafeRestore("protection namespace remains after restore")
    return restored
```
- [ ] Run focused tests, property tests, lint, and types.

```bash
uv run pytest test/python/test_protection.py test/python/test_fstring_properties.py -q
uv run ruff check .
uv run ruff format --check .
uv run ty check
```

- [ ] Commit.

```bash
git add python/inline_sql_helper/protection.py test/python/test_protection.py
git commit -m "feat: protect Python regions during SQL formatting"
```

## Task 9: Vendor and isolate `sqlparse` 0.5.5 reproducibly

**Files:**

- Create: `tools/sqlparse-vendor.lock`
- Create: `tools/sqlparse-vendor.requirements.txt`
- Create: `tools/vendor_sqlparse.py`
- Create: `tools/verify_vendor.py`
- Create: `python/bootstrap.py`
- Create: `python/vendor/sqlparse/`
- Create: `third_party/sqlparse/LICENSE`
- Create: `third_party/sqlparse/AUTHORS`
- Create: `third_party/sqlparse/SOURCE.json`
- Create: `third_party/sqlparse/files.sha256`
- Create: `test/python/test_vendor_sqlparse.py`
- Create: `test/python/test_bootstrap.py`

**Vendor lock:**

```ini
name=sqlparse
version=0.5.5
wheel=sqlparse-0.5.5-py3-none-any.whl
url=https://files.pythonhosted.org/packages/49/4b/359f28a903c13438ef59ebeee215fb25da53066db67b305c125f1c6d2a25/sqlparse-0.5.5-py3-none-any.whl
sha256=12a08b3bf3eec877c519589833aed092e2444e68240a3577e8e26148acc7b1ba
license=BSD-3-Clause
```

The OSV projection is a separate, generated-and-verified requirements lock:

```text
sqlparse==0.5.5
```

```py
class VendorError(ValueError):
    """A source-free vendor archive or provenance violation."""
```

- [ ] Write tests before the vendor script. Use synthetic wheel archives to reject a
  hash mismatch, path traversal, symlink, unexpected top-level package, missing
  license, missing `sqlparse/__init__.py`, wrong version, duplicate archive member,
  changed vendored file hash, and disagreement between `sqlparse-vendor.lock` and
  `sqlparse-vendor.requirements.txt`.

```py
def write_synthetic_wheel(
    root: Path,
    members: dict[str, bytes],
) -> Path:
    wheel = root / "synthetic.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        for name, payload in members.items():
            archive.writestr(name, payload)
    return wheel


@pytest.mark.parametrize(
    "member",
    [
        "../escape.py",
        "/absolute.py",
        "other/package.py",
        r"sqlparse\x\..\..\escape.py",
    ],
)
def test_vendor_rejects_unsafe_wheel_member(
    tmp_path: Path,
    member: str,
) -> None:
    wheel = write_synthetic_wheel(
        tmp_path,
        {
            "sqlparse/__init__.py": b'__version__ = "0.5.5"\n',
            "sqlparse-0.5.5.dist-info/METADATA": b"Version: 0.5.5\n",
            member: b"unsafe\n",
        },
    )
    with pytest.raises(VendorError):
        with zipfile.ZipFile(wheel) as archive:
            validated_members(archive)
```

- [ ] Add an extraction-boundary test on every supported OS. A member name containing
  any backslash is invalid even on POSIX, and each native extraction destination must
  resolve below the newly created staging root before bytes are written. Assert an
  invalid archive leaves both the final vendor tree and every path outside staging
  unchanged.

```py
def checked_destination(staging_root: Path, member_name: str) -> Path:
    if "\\" in member_name:
        raise VendorError("unsafe wheel member")
    destination = (staging_root / PurePosixPath(member_name)).resolve()
    if not destination.is_relative_to(staging_root.resolve()):
        raise VendorError("wheel member escapes staging")
    return destination
```
- [ ] Add an isolation test that creates a fake newer `sqlparse` on `PYTHONPATH`, then
  invokes bootstrap with `-I -S -B -X utf8 --self-check`. Assert the reported version
  is exactly 0.5.5, the loaded module path is below `python/vendor`, and no `.pyc`
  file is created.

```py
def test_bootstrap_ignores_pythonpath(
    tmp_path: Path,
    extension_root: Path,
) -> None:
    fake_package = make_fake_sqlparse(tmp_path, version="99.0.0")
    result = run_bootstrap(
        extension_root,
        env={"PYTHONPATH": str(fake_package)},
        arguments=("--self-check",),
    )
    assert result.returncode == 0
    assert json.loads(result.stdout) == {
        "ok": True,
        "sqlparseVersion": "0.5.5",
        "vendored": True,
    }
    assert result.stderr == ""
```

- [ ] Run and confirm failures because the vendor tree and bootstrap do not exist.

```bash
uv run pytest test/python/test_vendor_sqlparse.py test/python/test_bootstrap.py -q
```

- [ ] Implement `vendor_sqlparse.py` with `urllib.request` and `zipfile`. Download to a
  newly created temporary directory, verify SHA-256 before extraction, apply an exact
  member allowlist, normalize and validate every path, copy into a second temporary
  sibling vendor directory, and generate sorted file hashes. If the existing tree has
  identical hashes, leave it untouched. Otherwise rename the existing target to a
  validated sibling backup, rename the staged directory to the exact resolved
  `python/vendor/sqlparse` target, and roll back the backup on failure; remove the
  backup only after success. Do not rely on replacing a non-empty directory with one
  `os.replace` call. Never operate on a workspace root or unresolved path.

```py
def validated_members(
    archive: zipfile.ZipFile,
) -> tuple[zipfile.ZipInfo, ...]:
    members = tuple(archive.infolist())
    names = [member.filename for member in members]
    if len(names) != len(set(names)):
        raise VendorError("duplicate wheel member")
    for member in members:
        if "\\" in member.filename:
            raise VendorError("unsafe wheel member")
        path = PurePosixPath(member.filename)
        mode = member.external_attr >> 16
        if path.is_absolute() or ".." in path.parts or stat.S_ISLNK(mode):
            raise VendorError("unsafe wheel member")
        if not path.parts or path.parts[0] not in {
            "sqlparse",
            "sqlparse-0.5.5.dist-info",
        }:
            raise VendorError("unexpected wheel member")
    return members


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
```
- [ ] Run the vendor command once and commit its deterministic output. Store upstream
  license, authors, URL, wheel hash, version, and generation timestamp policy in
  `third_party/sqlparse`; the generated content itself must not depend on wall-clock
  time.

```bash
uv run python tools/vendor_sqlparse.py --lock tools/sqlparse-vendor.lock
uv run python tools/verify_vendor.py
```

- [ ] Implement bootstrap using paths derived only from `Path(__file__).resolve()`.
  Insert the fixed vendor root first and the fixed Python/helper root second with
  `sys.path[:0] = [str(vendor_root), str(python_root)]`, so a packaged
  `python/sqlparse.py` cannot shadow the vendored package. Verify
  `sqlparse.__version__ == "0.5.5"` and that its resolved file is inside the vendor
  root, and implement only `--self-check`, which emits one compact JSON object.
  For any other invocation in this task, exit with a source-free nonzero result.
  CLI import and stdin dispatch are intentionally added only after `cli.py` exists in
  Task 13. Put runtime preparation, provenance validation, argument dispatch, and
  output inside one outer exception guard so a corrupt archive or failed import cannot
  print Python's default traceback.

```py
@dataclass(frozen=True, slots=True)
class RuntimeContext:
    python_root: Path
    vendor_root: Path
    sqlparse: ModuleType


def prepare_runtime() -> RuntimeContext:
    python_root = Path(__file__).resolve().parent
    vendor_root = (python_root / "vendor").resolve()
    sys.dont_write_bytecode = True
    sys.path[:0] = [str(vendor_root), str(python_root)]
    sqlparse = importlib.import_module("sqlparse")
    module_file = Path(sqlparse.__file__).resolve()
    if (
        sqlparse.__version__ != "0.5.5"
        or not module_file.is_relative_to(vendor_root)
    ):
        raise RuntimeError("invalid vendored runtime")
    return RuntimeContext(python_root, vendor_root, sqlparse)


def self_check(runtime: RuntimeContext) -> int:
    response = {
        "ok": True,
        "sqlparseVersion": runtime.sqlparse.__version__,
        "vendored": True,
    }
    sys.stdout.write(json.dumps(response, separators=(",", ":")))
    return 0


def entrypoint() -> int:
    try:
        runtime = prepare_runtime()
        if sys.argv[1:] == ["--self-check"]:
            return self_check(runtime)
        return 70
    except BaseException:
        return 70


if __name__ == "__main__":
    raise SystemExit(entrypoint())
```
- [ ] Run isolation tests under Python 3.12, 3.13, and 3.14.

```bash
for version in 3.12 3.13 3.14; do
  uv run --python "$version" pytest \
    test/python/test_vendor_sqlparse.py test/python/test_bootstrap.py -q
done
uv run python tools/verify_vendor.py
uv run ruff check .
uv run ruff format --check .
uv run ty check
```

- [ ] Commit the vendor tree, provenance, tools, and tests.

```bash
git add tools/sqlparse-vendor.lock tools/vendor_sqlparse.py tools/verify_vendor.py \
  tools/sqlparse-vendor.requirements.txt python/bootstrap.py \
  python/vendor/sqlparse third_party/sqlparse \
  test/python/test_vendor_sqlparse.py test/python/test_bootstrap.py
git commit -m "build: vendor sqlparse 0.5.5"
```

## Task 10: Adapt `sqlparse` for single-line and triple-quoted SQL

**Files:**

- Create: `python/inline_sql_helper/sqlparse_adapter.py`
- Create: `test/python/test_sqlparse_adapter.py`

**Interfaces:**

```py
class SqlFormattingError(ValueError):
    """A source-free sqlparse adapter failure."""


@dataclass(frozen=True, slots=True)
class TripleQuoteFrame:
    leading_boundary: str
    trailing_boundary: str
    outer_indent: str
    sql_body: str


def split_triple_quote_frame(content: str) -> TripleQuoteFrame:
    """Separate exact blank boundaries and common outer indentation."""


def build_sqlparse_options(
    options: FormatOptions,
    *,
    triple_quoted: bool,
) -> dict[str, object]:
    """Map only approved options to sqlparse.format."""


def format_sql(
    protected_sql: str,
    *,
    triple_quoted: bool,
    options: FormatOptions,
) -> str:
    """Format protected SQL without changing the quote frame."""
```

- [ ] Add option-mapping tests first. For `keywordCase="preserve"`, assert the mapping
  omits `keyword_case` rather than passing a null value. Assert `identifier_case`,
  `truncate_strings`, and `output_format` are absent; `strip_comments` is false;
  `use_space_around_operators` follows configuration.

```py
@pytest.mark.parametrize("keyword_case", ["upper", "lower", "preserve"])
def test_only_approved_sqlparse_options(
    keyword_case: Literal["upper", "lower", "preserve"],
) -> None:
    options = FormatOptions(keyword_case, 2, 88, True)
    mapped = build_sqlparse_options(options, triple_quoted=True)
    assert mapped["strip_comments"] is False
    assert "identifier_case" not in mapped
    assert "truncate_strings" not in mapped
    assert "output_format" not in mapped
    assert ("keyword_case" in mapped) is (keyword_case != "preserve")
```

- [ ] Add golden tests for single-line SQL with upper, lower, and preserve modes.
  A single-quoted or double-quoted candidate must never gain a physical CR or LF;
  if `sqlparse` returns one, the adapter must raise a candidate-level formatting error.

```py
def test_short_string_rejects_formatter_newline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sqlparse, "format", lambda _sql, **_options: "SELECT\n1")
    with pytest.raises(SqlFormattingError):
        format_sql(
            "select 1",
            triple_quoted=False,
            options=FormatOptions("upper", 2, 88, True),
        )
```
- [ ] Add triple-quote golden tests for opening and closing blank lines, CRLF, Python
  block indent, blank SQL lines, `indentWidth` 1 and 8, `wrapAfter` 20 and 500,
  SQL comments, strings, semicolons, multiple statements, and parameter styles
  `$1`, `?`, `:name`, `%s`, `%(name)s`. `leading_boundary` and
  `trailing_boundary` hold all exact blank-line text, including closing indentation;
  they are not limited to one newline.

```py
def test_preserve_omits_keyword_case() -> None:
    options = FormatOptions(
        keyword_case="preserve",
        indent_width=2,
        wrap_after=88,
        use_space_around_operators=True,
    )
    mapped = build_sqlparse_options(options, triple_quoted=True)
    assert "keyword_case" not in mapped
    assert mapped["reindent"] is True
    assert mapped["indent_width"] == 2
    assert mapped["wrap_after"] == 88
```

- [ ] Add a regression test in which the final non-empty SQL line owns the newline
  immediately before the closing delimiter. Stub `sqlparse.format()` to drop that
  newline and prove the adapter still restores the newline plus closing indentation
  byte-for-byte for LF and CRLF.

```py
@pytest.mark.parametrize("line_ending", ["\n", "\r\n"])
def test_closing_boundary_survives_formatter_dropping_final_newline(
    line_ending: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    content = (
        line_ending
        + "    select 1"
        + line_ending
        + "    "
    )
    monkeypatch.setattr(sqlparse, "format", lambda _sql, **_options: "SELECT 1")

    frame = split_triple_quote_frame(content)
    assert frame.sql_body == "select 1"
    assert frame.trailing_boundary == line_ending + "    "
    assert format_sql(
        content,
        triple_quoted=True,
        options=FormatOptions("upper", 2, 88, True),
    ) == line_ending + "    SELECT 1" + line_ending + "    "
```

- [ ] Run focused tests and confirm the adapter is absent.

```bash
uv run pytest test/python/test_sqlparse_adapter.py -q
```

- [ ] Implement the exact option mapping. For triple quotes, preserve whether a newline
  appears immediately after the opening delimiter and immediately before the closing
  delimiter, dedent one common outer indent from non-empty SQL lines, call
  `sqlparse.format`, and restore that outer indent to every non-empty output line.
  Preserve the complete `leading_boundary`/`trailing_boundary` strings byte-for-byte,
  including multiple blank lines, CRLF versus LF, and closing indentation.

```py
def build_sqlparse_options(
    options: FormatOptions,
    *,
    triple_quoted: bool,
) -> dict[str, object]:
    mapped: dict[str, object] = {
        "reindent": triple_quoted,
        "strip_comments": False,
        "use_space_around_operators": options.use_space_around_operators,
    }
    if options.keyword_case != "preserve":
        mapped["keyword_case"] = options.keyword_case
    if triple_quoted:
        mapped["indent_width"] = options.indent_width
        mapped["wrap_after"] = options.wrap_after
    return mapped


def split_triple_quote_frame(content: str) -> TripleQuoteFrame:
    lines = content.splitlines(keepends=True)
    leading: list[str] = []
    while lines and lines[0].strip(" \t\r\n") == "":
        leading.append(lines.pop(0))
    trailing: list[str] = []
    while lines and lines[-1].strip(" \t\r\n") == "":
        trailing.insert(0, lines.pop())
    if lines:
        final_line = lines[-1]
        for line_ending in ("\r\n", "\n", "\r"):
            if final_line.endswith(line_ending):
                lines[-1] = final_line[: -len(line_ending)]
                trailing.insert(0, line_ending)
                break
    indents = [
        line[: len(line) - len(line.lstrip(" \t"))]
        for line in lines
        if line.strip(" \t\r\n")
    ]
    outer_indent = os.path.commonprefix(indents) if indents else ""
    body = "".join(
        line[len(outer_indent) :]
        if line.strip(" \t\r\n")
        else line
        for line in lines
    )
    return TripleQuoteFrame(
        leading_boundary="".join(leading),
        trailing_boundary="".join(trailing),
        outer_indent=outer_indent,
        sql_body=body,
    )


def format_sql(
    protected_sql: str,
    *,
    triple_quoted: bool,
    options: FormatOptions,
) -> str:
    mapped = build_sqlparse_options(options, triple_quoted=triple_quoted)
    if not triple_quoted:
        result = sqlparse.format(protected_sql, **mapped)
        if "\r" in result or "\n" in result:
            raise SqlFormattingError("short-string formatting introduced a newline")
        return result
    frame = split_triple_quote_frame(protected_sql)
    formatted = sqlparse.format(frame.sql_body, **mapped)
    indented = "".join(
        frame.outer_indent + line if line.strip(" \t\r\n") else line
        for line in formatted.splitlines(keepends=True)
    )
    return frame.leading_boundary + indented + frame.trailing_boundary
```

- [ ] Do not strip comments or identifiers, evaluate placeholders, truncate strings,
  or claim dialect validation. A result with a changed protected marker is left for
  Task 11 restoration checks.

```py
def test_comments_identifiers_and_parameters_survive() -> None:
    source = "select MixedCase, :name, %s -- keep\nfrom TableName"
    result = format_sql(
        source,
        triple_quoted=True,
        options=FormatOptions("upper", 2, 88, True),
    )
    assert "MixedCase" in result
    assert "TableName" in result
    assert ":name" in result
    assert "%s" in result
    assert "-- keep" in result
```
- [ ] Run adapter and vendor tests plus Python quality checks.

```bash
uv run pytest \
  test/python/test_sqlparse_adapter.py \
  test/python/test_vendor_sqlparse.py -q
uv run ruff check .
uv run ruff format --check .
uv run ty check
```

- [ ] Commit.

```bash
git add python/inline_sql_helper/sqlparse_adapter.py \
  test/python/test_sqlparse_adapter.py
git commit -m "feat: adapt sqlparse to Python string layout"
```

## Task 11: Format one candidate with all safety invariants

**Files:**

- Create: `python/inline_sql_helper/candidate_formatter.py`
- Create: `test/fixtures/helper/format-cases.json`
- Create: `test/python/test_candidate_formatter.py`
- Modify: `test/python/test_fstring_properties.py`

**Interfaces:**

```py
class SqlFormatter(Protocol):
    def __call__(
        self,
        protected_sql: str,
        *,
        triple_quoted: bool,
        options: FormatOptions,
    ) -> str:
        pass


@dataclass(frozen=True, slots=True)
class CandidateEdit:
    source_span: SourceSpan
    expected_text: str
    replacement_text: str


@dataclass(frozen=True, slots=True)
class CandidateSkip:
    source_span: SourceSpan
    reason: ReasonCode


@dataclass(frozen=True, slots=True)
class CandidateUnchanged:
    source_span: SourceSpan


type CandidateResult = CandidateEdit | CandidateUnchanged | CandidateSkip


def format_candidate(
    source: str,
    analysis: DocumentAnalysis,
    literal: SupportedLiteral,
    detection: SqlDetection,
    options: FormatOptions,
    *,
    nonce: str,
    sql_formatter: SqlFormatter,
) -> CandidateResult:
    """Return changed, unchanged, or safely skipped candidate state."""
```

- [ ] Create golden fixtures for normal, raw, f-, and raw-f strings across every
  delimiter. Include marker preservation, keyword modes, operator spacing, triple
  indentation, Unicode, SQL comments and strings, multiple statements, and every
  f-string form from Task 6. Include `--sql\r\nSELECT 1` and assert the marker line plus
  CRLF is byte-for-byte unchanged after formatting. Each fixture must state exact
  input, options, exact output, and expected reason when skipped.

```json
[
  {
    "id": "marker-crlf",
    "input": "query = \"\"\"--sql\r\nselect 1\"\"\"",
    "options": {
      "keywordCase": "upper",
      "indentWidth": 2,
      "wrapAfter": 88,
      "useSpaceAroundOperators": true
    },
    "output": "query = \"\"\"--sql\r\nSELECT 1\"\"\"",
    "reason": null
  }
]
```

- [ ] Add an already-formatted candidate and assert it returns
  `CandidateUnchanged`, never a zero-length or same-text edit.

```py
def format_only_candidate(
    source: str,
    *,
    sql_formatter: SqlFormatter,
) -> CandidateResult:
    analysis = analyze_document(source)
    literal = analysis.supported[0]
    return format_candidate(
        source,
        analysis,
        literal,
        detect_sql(literal, analysis.source_map),
        FormatOptions("upper", 2, 88, True),
        nonce="22" * 16,
        sql_formatter=sql_formatter,
    )


def apply_candidate_result(source: str, result: CandidateResult) -> str:
    if isinstance(result, CandidateEdit):
        return (
            source[: result.source_span.start]
            + result.replacement_text
            + source[result.source_span.end :]
        )
    if isinstance(result, CandidateUnchanged):
        return source
    raise AssertionError("candidate was skipped")


def test_already_formatted_is_unchanged() -> None:
    result = format_only_candidate('query = "SELECT 1"', sql_formatter=format_sql)
    assert isinstance(result, CandidateUnchanged)
```

- [ ] Add adversarial tests by injecting formatter doubles that delete, duplicate,
  reorder, or alter markers; introduce a physical newline into a short string; create
  the closing delimiter; leave a raw string with an invalid terminal backslash; alter
  an escape; change an escaped brace; return non-idempotent output; or raise.

```py
@dataclass(slots=True)
class AlternatingFormatter:
    values: tuple[str, str]
    calls: int = 0

    def __call__(
        self,
        protected_sql: str,
        *,
        triple_quoted: bool,
        options: FormatOptions,
    ) -> str:
        del protected_sql, triple_quoted, options
        value = self.values[min(self.calls, 1)]
        self.calls += 1
        return value


@pytest.mark.parametrize(
    "formatted",
    ["SELECT\n1", 'SELECT "', "SELECT \\"],
)
def test_adversarial_output_is_skipped(formatted: str) -> None:
    result = format_only_candidate(
        'query = r"select 1"',
        sql_formatter=AlternatingFormatter((formatted, formatted)),
    )
    assert isinstance(result, CandidateSkip)
```
- [ ] Assert successful output preserves the exact prefix, opening and closing
  delimiters, replacement fields, conversions, specs, escaped braces, Python escapes,
  and marker source. Parse the whole replaced document with the running interpreter.

```py
def test_non_idempotent_formatter_is_skipped() -> None:
    formatter = AlternatingFormatter(("SELECT  1", "SELECT 1"))
    result = format_only_candidate(
        'query = "select 1"',
        sql_formatter=formatter,
    )
    assert isinstance(result, CandidateSkip)
    assert result.reason is ReasonCode.FORMATTER_FAILED
```

- [ ] Run focused tests and confirm the formatter is absent.

```bash
uv run pytest \
  test/python/test_candidate_formatter.py \
  test/python/test_fstring_properties.py -q
```

- [ ] Implement the candidate pipeline: build protection plan; format once; restore;
  validate marker count/order/kind; reassemble the exact literal prefix and delimiters;
  validate raw-string and delimiter safety; compare all protected source fragments;
  substitute into the complete document; call `ast.parse`; format the candidate a
  second time using the same request-owned nonce and options; require identical output.
  `format_candidate()` never draws randomness.

```py
class CandidateFailure(Exception):
    def __init__(self, reason: ReasonCode) -> None:
        self.reason = reason
        super().__init__(reason.value)


def _literal_text(literal: SupportedLiteral, content: str) -> str:
    return f"{literal.prefix}{literal.delimiter}{content}{literal.delimiter}"


def _format_once(
    analysis: DocumentAnalysis,
    literal: SupportedLiteral,
    detection: SqlDetection,
    options: FormatOptions,
    nonce: str,
    sql_formatter: SqlFormatter,
) -> str:
    plan = build_protection_plan(
        analysis.source_map,
        literal,
        detection,
        nonce,
    )
    formatted = sql_formatter(
        plan.protected_sql,
        triple_quoted=len(literal.delimiter) == 3,
        options=options,
    )
    restored = restore_protected(formatted, plan)
    return _literal_text(literal, restored)


def _replace_source(source: str, span: SourceSpan, replacement: str) -> str:
    return source[: span.start] + replacement + source[span.end :]


def _replacement_literal(
    updated: DocumentAnalysis,
    original: SupportedLiteral,
) -> SupportedLiteral:
    matches = [
        item
        for item in updated.supported
        if item.span.start == original.span.start
    ]
    if len(matches) != 1:
        raise CandidateFailure(ReasonCode.FORMATTER_FAILED)
    result = matches[0]
    if (result.prefix, result.delimiter, result.kind) != (
        original.prefix,
        original.delimiter,
        original.kind,
    ):
        raise CandidateFailure(ReasonCode.UNSAFE_RAW_STRING)
    return result


def _field_texts(
    source_map: SourceMap,
    literal: SupportedLiteral,
) -> tuple[str, ...]:
    return tuple(source_map.slice(span) for span in literal.field_spans)


def _validate_replacement_and_idempotency(
    source: str,
    analysis: DocumentAnalysis,
    literal: SupportedLiteral,
    options: FormatOptions,
    nonce: str,
    sql_formatter: SqlFormatter,
    first: str,
) -> None:
    try:
        ast.parse(first, mode="eval")
    except (SyntaxError, ValueError):
        raise CandidateFailure(ReasonCode.UNSAFE_RAW_STRING) from None
    updated_source = _replace_source(source, literal.span, first)
    try:
        updated_analysis = analyze_document(updated_source)
    except (SyntaxError, tokenize.TokenError, ValueError):
        raise CandidateFailure(ReasonCode.FORMATTER_FAILED) from None
    updated_literal = _replacement_literal(updated_analysis, literal)
    if _field_texts(analysis.source_map, literal) != _field_texts(
        updated_analysis.source_map,
        updated_literal,
    ):
        raise CandidateFailure(ReasonCode.UNSAFE_FSTRING_RESTORE)
    updated_detection = detect_sql(updated_literal, updated_analysis.source_map)
    if not updated_detection.matched:
        raise CandidateFailure(ReasonCode.FORMATTER_FAILED)
    second = _format_once(
        updated_analysis,
        updated_literal,
        updated_detection,
        options,
        nonce,
        sql_formatter,
    )
    if second != first:
        raise CandidateFailure(ReasonCode.FORMATTER_FAILED)
```

- [ ] Map unsafe restoration to `UNSAFE_FSTRING_RESTORE`, raw/delimiter hazards to
  `UNSAFE_RAW_STRING`, and sqlparse/parse/idempotency failure to `FORMATTER_FAILED`.
  This function receives only `SupportedLiteral`; Task 12 maps detected unsupported
  units to `UNSUPPORTED_LITERAL` without calling the formatter. Return unchanged
  candidates as successful no-op results at engine level, not zero-length edits.

```py
def test_reason_mapping_distinguishes_literal_and_document_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    delimiter_hazard = format_only_candidate(
        'query = r"select 1"',
        sql_formatter=AlternatingFormatter(('SELECT "', 'SELECT "')),
    )
    assert isinstance(delimiter_hazard, CandidateSkip)
    assert delimiter_hazard.reason is ReasonCode.UNSAFE_RAW_STRING

    def fail_analysis(_source: str) -> Never:
        raise SyntaxError

    monkeypatch.setattr(
        candidate_formatter,
        "analyze_document",
        fail_analysis,
    )
    document_failure = format_only_candidate(
        'query = "select 1"',
        sql_formatter=AlternatingFormatter(("SELECT 1", "SELECT 1")),
    )
    assert isinstance(document_failure, CandidateSkip)
    assert document_failure.reason is ReasonCode.FORMATTER_FAILED
```

```py
def format_candidate(
    source: str,
    analysis: DocumentAnalysis,
    literal: SupportedLiteral,
    detection: SqlDetection,
    options: FormatOptions,
    *,
    nonce: str,
    sql_formatter: SqlFormatter,
) -> CandidateResult:
    expected = analysis.source_map.slice(literal.span)
    try:
        first = _format_once(
            analysis,
            literal,
            detection,
            options,
            nonce,
            sql_formatter,
        )
        _validate_replacement_and_idempotency(
            source,
            analysis,
            literal,
            options,
            nonce,
            sql_formatter,
            first,
        )
    except CandidateFailure as failure:
        return CandidateSkip(literal.span, failure.reason)
    except UnsafeRestore:
        return CandidateSkip(literal.span, ReasonCode.UNSAFE_FSTRING_RESTORE)
    except SqlFormattingError:
        return CandidateSkip(literal.span, ReasonCode.FORMATTER_FAILED)
    except Exception:
        return CandidateSkip(literal.span, ReasonCode.FORMATTER_FAILED)
    if first == expected:
        return CandidateUnchanged(literal.span)
    return CandidateEdit(literal.span, expected, first)
```

- [ ] Extend the property test: after successful formatting, all field source slices
  are byte-for-byte identical, the result parses on the same Python version, and a
  second call returns no change.

```py
@given(valid_fstring_sources())
def test_success_preserves_fields_and_is_idempotent(source: str) -> None:
    first = format_only_candidate(source, sql_formatter=format_sql)
    assume(isinstance(first, (CandidateEdit, CandidateUnchanged)))
    updated = apply_candidate_result(source, first)
    ast.parse(updated)
    second = format_only_candidate(updated, sql_formatter=format_sql)
    assert isinstance(second, CandidateUnchanged)
```
- [ ] Run on Python 3.12, 3.13, and 3.14 with full lint and type checks.

```bash
for version in 3.12 3.13 3.14; do
  uv run --python "$version" pytest \
    test/python/test_candidate_formatter.py \
    test/python/test_fstring_properties.py -q
done
uv run ruff check .
uv run ruff format --check .
uv run ty check
```

- [ ] Commit.

```bash
git add python/inline_sql_helper/candidate_formatter.py \
  test/fixtures/helper/format-cases.json \
  test/python/test_candidate_formatter.py \
  test/python/test_fstring_properties.py
git commit -m "feat: format candidates with source invariants"
```

## Task 12: Build document-level locate and format operations

**Files:**

- Create: `python/inline_sql_helper/engine.py`
- Create: `test/python/test_engine.py`

**Interfaces:**

```py
@dataclass(frozen=True, slots=True)
class EngineDependencies:
    random_bytes: Callable[[int], bytes]
    sql_formatter: SqlFormatter


@dataclass(frozen=True, slots=True)
class DetectedUnit:
    literal: SupportedLiteral | UnsupportedLiteral
    detection: SqlDetection

    @property
    def span(self) -> SourceSpan:
        return self.literal.span


@dataclass(frozen=True, slots=True)
class PreparedRequest:
    analysis: DocumentAnalysis
    discovered: tuple[DetectedUnit, ...]
    selected: tuple[DetectedUnit, ...]


def locate_request(
    request: HelperRequest,
    dependencies: EngineDependencies,
) -> LocateSuccess | ErrorResponse:
    """Return candidate ranges without edits."""


def format_request(
    request: HelperRequest,
    dependencies: EngineDependencies,
) -> FormatSuccess | ErrorResponse:
    """Format selected syntax units and return ordered non-overlapping edits."""
```

- [ ] Write mode tests first. Cursor selects only a containing candidate; selection
  expands to all intersecting literal units and rejects an empty range; all selects
  every candidate in one document/cell. Selection never sends arbitrary selected text
  to sqlparse.
- [ ] Write partial-success tests: safe candidate plus unsafe candidate returns the safe
  edit and one skip. Write request-failure tests: document parse failure, invalid
  protocol, a document of 5 MiB plus one byte, and 1,001 candidates return an error
  with zero edits.
  A candidate above 1 MiB is a skip while smaller candidates in the same selection/all
  request can succeed.
- [ ] Add one request containing safe SQL, SQL-shaped implicit concatenation, and a
  SQL-shaped literal under `BinOp(Add)`. Format returns one edit plus two
  `UNSUPPORTED_LITERAL` skips. Add bytes and Python 3.14 t-string cases and assert they
  are neither discovered candidates nor skips.
- [ ] Add explicit whole-request parse failures for Jupyter `%%sql`, `%sql`, and
  `!command` source, plus invalid/incomplete Python. Add positive content-based cases
  for the same SQL literal passed to `mo.sql`, `pandas.read_sql`, and an unrelated
  user-defined function, proving call names do not affect detection.
- [ ] Write locate tests showing the same content detector and target rules are used,
  but no formatter call occurs and no edit text is produced.
- [ ] Keep locate useful for Code Actions by returning only supported candidate ranges.
  A cursor-format request on a detected unsupported unit returns its skip reason, while
  locate does not advertise an action that can never edit.
- [ ] Fix the zero-candidate contract: `locate` returns
  `ok: true, candidates: []` when discovery or target intersection is empty, while
  `format` returns request-level `NO_SQL_CANDIDATE` with no edits when selection finds
  nothing. A detected marker-only supported literal is not this case: it returns a
  successful unchanged summary.

```py
def test_zero_candidate_contract() -> None:
    locate = locate_document('value = "plain text"', mode=FormatMode.ALL)
    assert locate.ok is True
    assert locate.candidates == ()
    formatted = format_document('value = "plain text"', mode=FormatMode.ALL)
    assert formatted.ok is False
    assert formatted.error.code is ReasonCode.NO_SQL_CANDIDATE
```

- [ ] Add a marker-only candidate with no substantive SQL token. It is discoverable by
  locate, but format returns an unchanged summary and no edit.
- [ ] Write ordering tests: edits are sorted descending for application, ranges never
  overlap, summary counts equal discovered/selected/changed/unchanged/skipped counts,
  and exact 1,000-candidate and size boundaries pass.

```py
def test_all_allows_candidate_level_partial_success() -> None:
    response = format_document_fixture("one-safe-one-unsafe")
    assert response.ok is True
    assert len(response.edits) == 1
    assert len(response.skips) == 1
    assert response.summary.changed == 1
    assert response.summary.skipped == 1
```

- [ ] Run and confirm failure because the engine is absent.

```bash
uv run pytest test/python/test_engine.py -q
```

- [ ] Implement one initial parse and literal analysis per request. Enforce resource
  limits in UTF-8 bytes, not Python character count. Select complete literal spans by
  cursor containment or non-empty range intersection. Allocate exactly one nonce from
  the complete request source, then pass that same nonce to every selected candidate
  and to both idempotence passes. Validate each candidate independently against the
  original source and original `DocumentAnalysis`; do not feed a virtually edited
  document back into original candidate ranges.

```py
MAX_DOCUMENT_BYTES = 5 * 1024 * 1024
MAX_CANDIDATE_BYTES = 1024 * 1024
MAX_CANDIDATES = 1_000


def _discover(analysis: DocumentAnalysis) -> tuple[DetectedUnit, ...]:
    literals: tuple[SupportedLiteral | UnsupportedLiteral, ...] = (
        *analysis.supported,
        *analysis.unsupported,
    )
    units = [
        DetectedUnit(literal, detection)
        for literal in literals
        if (detection := detect_sql(literal, analysis.source_map)).matched
    ]
    return tuple(sorted(units, key=lambda unit: unit.span))


def _select(
    units: Sequence[DetectedUnit],
    request: HelperRequest,
    source_map: SourceMap,
) -> tuple[DetectedUnit, ...]:
    if request.target.mode is FormatMode.ALL:
        return tuple(units)
    if request.target.mode is FormatMode.CURSOR:
        if request.target.cursor is None:
            raise PositionMappingError("cursor payload is absent")
        cursor = source_map.offset_from_vscode(
            request.target.cursor.line,
            request.target.cursor.character,
        )
        return tuple(
            unit for unit in units if unit.span.start <= cursor < unit.span.end
        )
    if request.target.selection is None:
        raise PositionMappingError("selection payload is absent")
    selected_span = SourceSpan(
        source_map.offset_from_vscode(
            request.target.selection.start.line,
            request.target.selection.start.character,
        ),
        source_map.offset_from_vscode(
            request.target.selection.end.line,
            request.target.selection.end.character,
        ),
    )
    return tuple(
        unit
        for unit in units
        if unit.span.start < selected_span.end
        and selected_span.start < unit.span.end
    )


def _prepare(
    request: HelperRequest,
) -> PreparedRequest | ErrorResponse:
    if len(request.source.encode("utf-8")) > MAX_DOCUMENT_BYTES:
        return error_response(
            request.operation,
            ReasonCode.RESOURCE_LIMIT_EXCEEDED,
        )
    try:
        analysis = analyze_document(request.source)
        discovered = _discover(analysis)
        if len(discovered) > MAX_CANDIDATES:
            return error_response(
                request.operation,
                ReasonCode.RESOURCE_LIMIT_EXCEEDED,
            )
        selected = _select(discovered, request, analysis.source_map)
    except (SyntaxError, tokenize.TokenError):
        return error_response(
            request.operation,
            ReasonCode.DOCUMENT_PARSE_FAILED,
        )
    except PositionMappingError:
        return error_response(request.operation, ReasonCode.PROTOCOL_ERROR)
    return PreparedRequest(analysis, discovered, selected)
```

- [ ] Run detection over both supported units and unsupported units with a
  `detection_content_span`. Selected detected unsupported units go directly to
  `UNSUPPORTED_LITERAL` skips and never reach protection or sqlparse. Exclude bytes,
  t-strings, and unsupported units with no detection span from candidate counts.

```py
def _format_unit(
    request: HelperRequest,
    prepared: PreparedRequest,
    unit: DetectedUnit,
    nonce: str,
    dependencies: EngineDependencies,
) -> CandidateResult:
    if isinstance(unit.literal, UnsupportedLiteral):
        return CandidateSkip(unit.span, ReasonCode.UNSUPPORTED_LITERAL)
    literal_text = prepared.analysis.source_map.slice(unit.span)
    if len(literal_text.encode("utf-8")) > MAX_CANDIDATE_BYTES:
        return CandidateSkip(
            unit.span,
            ReasonCode.RESOURCE_LIMIT_EXCEEDED,
        )
    return format_candidate(
        request.source,
        prepared.analysis,
        unit.literal,
        unit.detection,
        request.options,
        nonce=nonce,
        sql_formatter=dependencies.sql_formatter,
    )


def _combined_source(
    source: str,
    edits: Sequence[CandidateEdit],
) -> str:
    result = source
    for edit in sorted(
        edits,
        key=lambda item: item.source_span.start,
        reverse=True,
    ):
        result = (
            result[: edit.source_span.start]
            + edit.replacement_text
            + result[edit.source_span.end :]
        )
    return result
```

- [ ] Keep `locate` and `format` selection semantics identical. Produce no-op summaries
  for supported units; locate filters the unsupported skip-only units described above.
  A zero-result locate is a successful empty result; a zero-result format is
  `NO_SQL_CANDIDATE`. Produce unchanged summaries without edits for selected supported
  units whose content needs no change. Convert all positions through `SourceMap`.
  Before serializing a
  multi-edit success, apply every accepted edit in descending offset order to the
  original in-memory source and parse the combined document once more; if that combined
  result cannot parse, return request-level `FORMATTER_FAILED` with zero edits.

```py
def locate_request(
    request: HelperRequest,
    dependencies: EngineDependencies,
) -> LocateSuccess | ErrorResponse:
    del dependencies
    prepared = _prepare(request)
    if isinstance(prepared, ErrorResponse):
        return prepared
    candidates = tuple(
        prepared.analysis.source_map.vscode_range(unit.span)
        for unit in prepared.selected
        if isinstance(unit.literal, SupportedLiteral)
        and len(
            prepared.analysis.source_map.slice(unit.span).encode("utf-8")
        )
        <= MAX_CANDIDATE_BYTES
    )
    return LocateSuccess(
        protocol_version=1,
        operation=ProtocolOperation.LOCATE,
        ok=True,
        candidates=candidates,
    )


def format_request(
    request: HelperRequest,
    dependencies: EngineDependencies,
) -> FormatSuccess | ErrorResponse:
    prepared = _prepare(request)
    if isinstance(prepared, ErrorResponse):
        return prepared
    if not prepared.selected:
        return error_response(
            request.operation,
            ReasonCode.NO_SQL_CANDIDATE,
        )
    try:
        nonce = allocate_nonce(request.source, dependencies.random_bytes)
    except UnsafeRestore:
        return error_response(
            request.operation,
            ReasonCode.FORMATTER_FAILED,
        )
    results = tuple(
        _format_unit(request, prepared, unit, nonce, dependencies)
        for unit in prepared.selected
    )
    candidate_edits = tuple(
        result for result in results if isinstance(result, CandidateEdit)
    )
    try:
        ast.parse(_combined_source(request.source, candidate_edits))
    except SyntaxError:
        return error_response(
            request.operation,
            ReasonCode.FORMATTER_FAILED,
        )
    ordered = tuple(
        sorted(
            candidate_edits,
            key=lambda edit: edit.source_span.start,
            reverse=True,
        )
    )
    edits = tuple(
        FormatEdit(
            range=prepared.analysis.source_map.vscode_range(edit.source_span),
            expected_text=edit.expected_text,
            new_text=edit.replacement_text,
        )
        for edit in ordered
    )
    skips = tuple(
        CandidateSkipPayload(
            range=prepared.analysis.source_map.vscode_range(result.source_span),
            reason=result.reason,
        )
        for result in results
        if isinstance(result, CandidateSkip)
    )
    changed = len(edits)
    unchanged = sum(isinstance(result, CandidateUnchanged) for result in results)
    return FormatSuccess(
        protocol_version=1,
        operation=ProtocolOperation.FORMAT,
        ok=True,
        edits=edits,
        skips=skips,
        summary=FormatSummary(
            discovered=len(prepared.discovered),
            selected=len(prepared.selected),
            changed=changed,
            unchanged=unchanged,
            skipped=len(skips),
        ),
    )
```
- [ ] Run engine, candidate, protocol, and position tests plus quality checks.

```bash
uv run pytest \
  test/python/test_engine.py \
  test/python/test_candidate_formatter.py \
  test/python/test_protocol.py \
  test/python/test_positions.py -q
uv run ruff check .
uv run ruff format --check .
uv run ty check
```

- [ ] Commit.

```bash
git add python/inline_sql_helper/engine.py test/python/test_engine.py
git commit -m "feat: format document targets with partial success"
```

## Task 13: Expose a one-shot, source-silent helper CLI

**Files:**

- Create: `python/inline_sql_helper/cli.py`
- Modify: `python/bootstrap.py`
- Create: `test/python/test_cli.py`
- Modify: `test/python/test_bootstrap.py`

**Interfaces:**

```py
class InputTooLarge(Exception):
    """The helper input exceeded its fixed byte cap."""


def read_bounded(stream: BinaryIO, limit: int) -> bytes:
    """Read at most limit plus one bytes and reject overflow."""


def run(payload: bytes) -> bytes:
    """Return exactly one UTF-8 JSON response for one request."""


def main() -> int:
    """Write one protocol response and return 0, or return 70 before protocol startup."""
```

- [ ] Write subprocess tests first for valid locate and format requests, malformed
  UTF-8, malformed JSON, unknown protocol version, empty stdin, extra JSON after the
  request, helper exception, and a request containing a unique secret-like SQL value.
  Assert stdout is one JSON object, stderr is empty, and the unique source value appears
  only where protocol edit payload requires it. Malformed input, validation failure,
  and engine request errors still return code 0 after emitting their complete
  `ok: false` protocol response; this preserves their specific reason code for Task 16.
  Exit 70 is reserved for bootstrap/provenance failure before a protocol response can
  be constructed.

```py
@pytest.mark.parametrize("payload", [b"", b"{", b"\xff", b"{}{}"])
def test_protocol_errors_are_complete_responses_with_zero_exit(
    bootstrap: Path,
    payload: bytes,
) -> None:
    result = run_bootstrap(bootstrap, payload)
    assert result.returncode == 0
    assert decode_response(result.stdout).error.code is ReasonCode.PROTOCOL_ERROR
    assert result.stderr == b""
```
- [ ] Capture the process environment and prove `PYTHONPATH`, user site packages, and
  current working directory cannot replace helper or vendor imports. Run from a
  workspace containing fake `inline_sql_helper` and `sqlparse` packages.

```py
def test_bootstrap_loads_only_packaged_code(
    fake_workspace: Path,
    bootstrap: Path,
) -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-I",
            "-S",
            "-B",
            "-X",
            "utf8",
            str(bootstrap),
        ],
        input=valid_locate_request(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=fake_workspace,
        check=False,
    )
    assert result.returncode == 0
    assert decode_response(result.stdout).ok is True
    assert result.stderr == b""
```

- [ ] Run and confirm failures because the CLI is absent.

```bash
uv run pytest test/python/test_cli.py test/python/test_bootstrap.py -q
```

- [ ] Implement bounded stdin reading with the 32 MiB protocol cap, which covers a
  maximally JSON-escaped 5 MiB source plus request metadata. Decode strict UTF-8, parse
  one JSON value, validate, dispatch locate/format, serialize compact UTF-8 JSON, and
  write once. If a source-free `ErrorResponse` can be serialized, `main()` writes it
  and returns 0 regardless of `ok`; it never converts an application/protocol error to
  a nonzero process status.

```py
MAX_STDIN_BYTES = 32 * 1024 * 1024
MAX_STDOUT_BYTES = 64 * 1024 * 1024


def read_bounded(stream: BinaryIO, limit: int) -> bytes:
    payload = stream.read(limit + 1)
    if len(payload) > limit:
        raise InputTooLarge
    return payload


def peek_operation(
    value: object,
) -> ProtocolOperation | Literal["unknown"]:
    if not isinstance(value, dict):
        return "unknown"
    operation = value.get("operation")
    if operation == "locate":
        return ProtocolOperation.LOCATE
    if operation == "format":
        return ProtocolOperation.FORMAT
    return "unknown"


def run(payload: bytes) -> bytes:
    operation: ProtocolOperation | Literal["unknown"] = "unknown"
    if len(payload) > MAX_STDIN_BYTES:
        return serialize_response(
            error_response(
                operation,
                ReasonCode.RESOURCE_LIMIT_EXCEEDED,
            )
        )
    try:
        value = decode_json(payload)
        operation = peek_operation(value)
        request = parse_request(value)
        dependencies = EngineDependencies(
            random_bytes=secrets.token_bytes,
            sql_formatter=format_sql,
        )
        response: HelperResponse = (
            locate_request(request, dependencies)
            if request.operation is ProtocolOperation.LOCATE
            else format_request(request, dependencies)
        )
    except ProtocolViolation:
        response = error_response(operation, ReasonCode.PROTOCOL_ERROR)
    except Exception:
        response = error_response(operation, ReasonCode.PROCESS_FAILED)
    output = serialize_response(response)
    if len(output) > MAX_STDOUT_BYTES:
        return serialize_response(
            error_response(
                operation,
                ReasonCode.RESOURCE_LIMIT_EXCEEDED,
            )
        )
    return output


def main() -> int:
    try:
        payload = read_bounded(sys.stdin.buffer, MAX_STDIN_BYTES)
        output = run(payload)
    except InputTooLarge:
        output = serialize_response(
            error_response("unknown", ReasonCode.RESOURCE_LIMIT_EXCEEDED)
        )
    sys.stdout.buffer.write(output)
    sys.stdout.buffer.flush()
    return 0
```

`run()` itself enforces the 32 MiB input cap for direct callers. After peeking a valid
operation and serializing the engine response, it also enforces the 64 MiB output cap;
an oversized output is replaced with
`error_response(operation, RESOURCE_LIMIT_EXCEEDED)`, preserving `locate` or `format`
rather than reverting to `"unknown"`.

- [ ] Modify bootstrap's non-`--self-check` branch to import
  `inline_sql_helper.cli.main` only after the fixed helper/vendor paths and sqlparse
  provenance have passed validation, then return that function's exit status. A
  bootstrap/provenance failure exits 70 without writing a misleading protocol
  response. After import, verify `inline_sql_helper.cli.__file__` resolves below the
  fixed `python/inline_sql_helper` directory before calling `main()`.
  Catch expected and unexpected exceptions into source-free `ErrorResponse` values.

```py
def dispatch(runtime: RuntimeContext) -> int:
    from inline_sql_helper import cli

    helper_root = (runtime.python_root / "inline_sql_helper").resolve()
    cli_file = Path(cli.__file__).resolve()
    if not cli_file.is_relative_to(helper_root):
        return 70
    return cli.main()


def entrypoint() -> int:
    try:
        runtime = prepare_runtime()
        if sys.argv[1:] == ["--self-check"]:
            return self_check(runtime)
        if sys.argv[1:]:
            return 70
        return dispatch(runtime)
    except BaseException:
        return 70


if __name__ == "__main__":
    raise SystemExit(entrypoint())
```

- [ ] Ensure bootstrap imports CLI only after fixed-path/vendor verification. Do not
  configure logging. Do not write tracebacks or payload excerpts to either stream.
  Corrupt-vendor, vendor-import, helper-import, and provenance failures each assert
  exit status 70, empty stdout, and empty stderr; this distinguishes a guarded
  pre-protocol failure from an `ok:false` response.

```py
def test_bootstrap_failure_is_source_silent(
    bootstrap: Path,
    corrupted_vendor: Path,
) -> None:
    result = subprocess.run(
        [sys.executable, "-I", "-S", "-B", "-X", "utf8", str(bootstrap)],
        input=b'{"source":"SECRET-SQL"}',
        cwd=corrupted_vendor,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    assert result.returncode == 70
    assert result.stdout == b""
    assert result.stderr == b""
```
- [ ] Run the exact production command and parse its sole output.

```bash
printf '%s' \
  '{"protocolVersion":1,"operation":"locate","source":"query = \"SELECT 1\"","target":{"mode":"all"},"options":{"keywordCase":"upper","indentWidth":2,"wrapAfter":88,"useSpaceAroundOperators":true}}' \
  | python3 -I -S -B -X utf8 python/bootstrap.py
```

- [ ] Run the full Python suite on 3.12, 3.13, and 3.14.

```bash
for version in 3.12 3.13 3.14; do
  uv run --python "$version" pytest test/python -q
done
uv run ruff check .
uv run ruff format --check .
uv run ty check
```

- [ ] Commit.

```bash
git add python/bootstrap.py python/inline_sql_helper/cli.py \
  test/python/test_cli.py test/python/test_bootstrap.py
git commit -m "feat: expose isolated formatting helper"
```

## Task 14: Resolve supported documents, notebook cells, and configuration

**Files:**

- Create: `src/vscode/document-target.ts`
- Create: `src/vscode/configuration.ts`
- Create: `test/support/vscode-mock.ts`
- Create: `test/ts/document-target.test.ts`
- Create: `test/ts/configuration.test.ts`
- Modify: `package.json`

**Interfaces:**

```ts
export interface SupportedDocument {
  readonly document: vscode.TextDocument;
  readonly documentUri: vscode.Uri;
  readonly resourceUri: vscode.Uri;
  readonly notebook?: vscode.NotebookDocument;
  readonly cell?: vscode.NotebookCell;
}

export type TargetResolution =
  | {
      readonly ok: true;
      readonly target: SupportedDocument;
      readonly editor: vscode.TextEditor;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "NO_ACTIVE_EDITOR"
        | "NOTEBOOK_CELL_FOCUS_REQUIRED"
        | "UNSUPPORTED_DOCUMENT";
    };

export function findNotebookCell(
  document: vscode.TextDocument,
  notebooks: readonly vscode.NotebookDocument[],
): { notebook: vscode.NotebookDocument; cell: vscode.NotebookCell } | undefined;

export function resolveSupportedDocument(
  document: vscode.TextDocument,
  notebooks: readonly vscode.NotebookDocument[],
): SupportedDocument | undefined;

export function resolveEditorTarget(editor: vscode.TextEditor): TargetResolution;
export function resolveActiveEditorTarget(): TargetResolution;

export type FormatOptionsResult =
  | { readonly ok: true; readonly options: FormatOptions }
  | { readonly ok: false; readonly reason: "INVALID_CONFIGURATION" };

export type PythonPathResult =
  | { readonly ok: true; readonly value: string | undefined }
  | {
      readonly ok: false;
      readonly reason: "INVALID_CONFIGURATION" | "WORKSPACE_UNTRUSTED";
    };

export function readFormatOptions(resourceUri: vscode.Uri): FormatOptionsResult;
export function readConfiguredPythonPath(
  resourceUri: vscode.Uri,
): PythonPathResult;
```

The unit mock exposes only typed Extension API values used by first-party modules and a
test control surface:

```ts
export interface VscodeMockControl {
  reset(): void;
  document(input: {
    readonly uri: string;
    readonly languageId: string;
    readonly text?: string;
    readonly version?: number;
  }): vscode.TextDocument;
  editor(document: vscode.TextDocument): vscode.TextEditor;
  notebook(input: {
    readonly uri: string;
    readonly notebookType: string;
    readonly cells: readonly vscode.TextDocument[];
  }): vscode.NotebookDocument;
  setActiveEditor(editor: vscode.TextEditor | undefined): void;
  setActiveNotebook(notebook: vscode.NotebookDocument | undefined): void;
  setNotebookDocuments(notebooks: readonly vscode.NotebookDocument[]): void;
  setConfiguration(resource: vscode.Uri, key: string, value: unknown): void;
  configurationReads(key: string): number;
  setTrusted(trusted: boolean): void;
  fireTrustGrant(): void;
}

export const __mock: VscodeMockControl;
```

- [ ] Write document-target tests first with VS Code fakes for standalone `python` and
  `mo-python`, Jupyter `python`, marimo `python`, marimo `mo-python`, wrong notebook
  type, SQL cell, raw `.ipynb` JSON editor, missing active editor, and a notebook with
  no focused cell editor.

```ts
it.each(["python", "mo-python"])(
  "resolves standalone %s",
  (languageId) => {
    const document = __mock.document({
      uri: `file:///query-${languageId}.py`,
      languageId,
    });
    const target = resolveSupportedDocument(document, []);
    expect(target?.documentUri.toString()).toBe(document.uri.toString());
    expect(target?.resourceUri.toString()).toBe(document.uri.toString());
  },
);

it.each([
  ["file:///raw.ipynb", "json"],
  ["file:///query.sql", "sql"],
])("rejects unsupported %s", (uri, languageId) => {
  const document = __mock.document({ uri, languageId });
  expect(resolveSupportedDocument(document, [])).toBeUndefined();
});
```

- [ ] Assert standalone resolution uses the document URI as `resourceUri`; notebook
  resolution finds membership through `workspace.notebookDocuments[].getCells()` and
  uses the notebook URI for resource configuration/interpreter selection.

```ts
it("resolves notebook membership before language fallback", () => {
  const document = __mock.document({
    uri: "vscode-notebook-cell:///query#0",
    languageId: "python",
  });
  const notebook = __mock.notebook({
    uri: "file:///query.ipynb",
    notebookType: "jupyter-notebook",
    cells: [document],
  });
  expect(
    resolveSupportedDocument(document, [notebook])?.resourceUri.toString(),
  ).toBe(notebook.uri.toString());
});
```
- [ ] Write configuration tests for all defaults and valid boundaries. Assert a wrong
  enum/type, `indentWidth` outside 1–8, or `wrapAfter` outside 20–500 returns
  `INVALID_CONFIGURATION` and does not substitute defaults. Assert `pythonPath` is not
  read from workspace configuration while untrusted.

```ts
it("uses the notebook URI for a marimo mo-python cell", () => {
  const target = resolveSupportedDocument(cell.document, [marimoNotebook]);
  expect(target?.resourceUri.toString()).toBe(marimoNotebook.uri.toString());
  expect(target?.cell?.document.languageId).toBe("mo-python");
});
```

- [ ] Run and confirm the modules are missing.

```bash
bun run test:unit -- \
  test/ts/document-target.test.ts \
  test/ts/configuration.test.ts
```

- [ ] Implement runtime membership guards rather than relying on a language-only
  `DocumentSelector`. Declare exact notebook selectors for
  `jupyter-notebook/python`, `marimo-notebook/python`, and
  `marimo-notebook/mo-python`, while standalone runtime guards accept only documents
  not found in any open notebook.

```ts
export const INLINE_SQL_SELECTOR: vscode.DocumentSelector = [
  { language: "python" },
  { language: "mo-python" },
  { notebookType: "jupyter-notebook", language: "python" },
  { notebookType: "marimo-notebook", language: "python" },
  { notebookType: "marimo-notebook", language: "mo-python" },
];

const standaloneLanguages = new Set(["python", "mo-python"]);
const notebookPairs = new Set([
  "jupyter-notebook\0python",
  "marimo-notebook\0python",
  "marimo-notebook\0mo-python",
]);

export function findNotebookCell(
  document: vscode.TextDocument,
  notebooks: readonly vscode.NotebookDocument[],
): { notebook: vscode.NotebookDocument; cell: vscode.NotebookCell } | undefined {
  for (const notebook of notebooks) {
    const cell = notebook
      .getCells()
      .find((item) => item.document.uri.toString() === document.uri.toString());
    if (cell !== undefined) return { notebook, cell };
  }
  return undefined;
}

export function resolveSupportedDocument(
  document: vscode.TextDocument,
  notebooks: readonly vscode.NotebookDocument[],
): SupportedDocument | undefined {
  const member = findNotebookCell(document, notebooks);
  if (member !== undefined) {
    const key = `${member.notebook.notebookType}\0${document.languageId}`;
    if (!notebookPairs.has(key)) return undefined;
    return {
      document,
      documentUri: document.uri,
      resourceUri: member.notebook.uri,
      notebook: member.notebook,
      cell: member.cell,
    };
  }
  if (!standaloneLanguages.has(document.languageId)) return undefined;
  return {
    document,
    documentUri: document.uri,
    resourceUri: document.uri,
  };
}

export function resolveEditorTarget(
  editor: vscode.TextEditor,
): TargetResolution {
  const target = resolveSupportedDocument(
    editor.document,
    vscode.workspace.notebookDocuments,
  );
  return target === undefined
    ? { ok: false, reason: "UNSUPPORTED_DOCUMENT" }
    : { ok: true, target, editor };
}

export function resolveActiveEditorTarget(): TargetResolution {
  const activeNotebook = vscode.window.activeNotebookEditor?.notebook;
  const editor = vscode.window.activeTextEditor;
  if (activeNotebook !== undefined) {
    if (
      editor === undefined ||
      findNotebookCell(editor.document, [activeNotebook]) === undefined
    ) {
      return { ok: false, reason: "NOTEBOOK_CELL_FOCUS_REQUIRED" };
    }
    return resolveEditorTarget(editor);
  }
  return editor === undefined
    ? { ok: false, reason: "NO_ACTIVE_EDITOR" }
    : resolveEditorTarget(editor);
}
```

- [ ] Implement `vscode-mock.ts` with resettable `Uri`, `Position`, `Range`,
  `Selection`, `WorkspaceEdit`, `CancellationTokenSource`, `EventEmitter`,
  `CodeAction`, `CodeActionKind`, `window`, `workspace`, `languages`, and `commands`
  members used by Tasks 14–18. Throw on any unimplemented API access so tests cannot
  silently rely on an inert object. Call `__mock.reset()` from `beforeEach`.

```ts
const state: {
  activeEditor: vscode.TextEditor | undefined;
  activeNotebook: vscode.NotebookEditor | undefined;
  notebooks: readonly vscode.NotebookDocument[];
  trusted: boolean;
  configurations: Map<string, Map<string, unknown>>;
} = {
  activeEditor: undefined,
  activeNotebook: undefined,
  notebooks: [],
  trusted: true,
  configurations: new Map(),
};

function getMockConfiguration(
  section: string,
  resource?: vscode.Uri,
): vscode.WorkspaceConfiguration {
  const key = `${resource?.toString() ?? ""}\0${section}`;
  const values = state.configurations.get(key);
  return {
    get<T>(name: string): T | undefined {
      return values?.get(name) as T | undefined;
    },
  } as vscode.WorkspaceConfiguration;
}


function failUnimplemented(name: string): never {
  throw new Error(`vscode mock member is not implemented: ${name}`);
}

export const window = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === "activeTextEditor") return state.activeEditor;
      if (property === "activeNotebookEditor") return state.activeNotebook;
      return failUnimplemented(`window.${String(property)}`);
    },
  },
) as typeof vscode.window;

export const workspace = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === "isTrusted") return state.trusted;
      if (property === "notebookDocuments") return state.notebooks;
      if (property === "getConfiguration") return getMockConfiguration;
      return failUnimplemented(`workspace.${String(property)}`);
    },
  },
) as typeof vscode.workspace;
```

- [ ] Implement resource-scoped configuration reads and strict validation. Add all
  schema minimums, maximums, enum values, defaults, `scope: "resource"`, and restricted
  `pythonPath` to `package.json`.

```ts
function integerBetween(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

export function readFormatOptions(
  resourceUri: vscode.Uri,
): FormatOptionsResult {
  const configuration = vscode.workspace.getConfiguration("inlineSql", resourceUri);
  const keywordCaseValue = configuration.get<unknown>("format.keywordCase");
  const indentWidthValue = configuration.get<unknown>("format.indentWidth");
  const wrapAfterValue = configuration.get<unknown>("format.wrapAfter");
  const operatorSpacingValue = configuration.get<unknown>(
    "format.useSpaceAroundOperators",
  );
  const keywordCase =
    keywordCaseValue === undefined ? "upper" : keywordCaseValue;
  const indentWidth =
    indentWidthValue === undefined ? 2 : indentWidthValue;
  const wrapAfter = wrapAfterValue === undefined ? 88 : wrapAfterValue;
  const useSpaceAroundOperators =
    operatorSpacingValue === undefined ? true : operatorSpacingValue;
  if (
    !(
      keywordCase === "upper" ||
      keywordCase === "lower" ||
      keywordCase === "preserve"
    ) ||
    !integerBetween(indentWidth, 1, 8) ||
    !integerBetween(wrapAfter, 20, 500) ||
    typeof useSpaceAroundOperators !== "boolean"
  ) {
    return { ok: false, reason: "INVALID_CONFIGURATION" };
  }
  return {
    ok: true,
    options: {
      keywordCase,
      indentWidth,
      wrapAfter,
      useSpaceAroundOperators,
    },
  };
}

export function readConfiguredPythonPath(
  resourceUri: vscode.Uri,
): PythonPathResult {
  if (!vscode.workspace.isTrusted) {
    return { ok: false, reason: "WORKSPACE_UNTRUSTED" };
  }
  const value = vscode.workspace
    .getConfiguration("inlineSql", resourceUri)
    .get<unknown>("pythonPath");
  if (value === undefined || value === "") return { ok: true, value: undefined };
  return typeof value === "string"
    ? { ok: true, value }
    : { ok: false, reason: "INVALID_CONFIGURATION" };
}
```
- [ ] Run focused tests, manifest tests, lint, and types.

```bash
bun run test:unit -- \
  test/ts/document-target.test.ts \
  test/ts/configuration.test.ts \
  test/ts/manifest.test.ts
bun run lint
bun run typecheck
```

- [ ] Commit.

```bash
git add src/vscode/document-target.ts src/vscode/configuration.ts \
  test/support/vscode-mock.ts \
  test/ts/document-target.test.ts test/ts/configuration.test.ts package.json
git commit -m "feat: resolve Python and notebook format targets"
```

## Task 15: Resolve Python interpreters and enforce Workspace Trust

**Files:**

- Create: `src/vscode/python-resolver.ts`
- Create: `test/ts/python-resolver.test.ts`
- Create: `test/ts/workspace-trust.test.ts`
- Modify: `package.json`
- Modify: `package.nls.json`
- Modify: `package.nls.ja.json`

**Interfaces:**

```ts
export interface ResolvedPython {
  readonly executable: string;
  readonly version: {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
  };
  readonly source: "configuration" | "python-extension" | "path";
}

export type ResolvedPythonResult =
  | { readonly ok: true; readonly python: ResolvedPython }
  | {
      readonly ok: false;
      readonly reason:
        | "PYTHON_NOT_FOUND"
        | "PYTHON_VERSION_UNSUPPORTED"
        | "WORKSPACE_UNTRUSTED"
        | "INVALID_CONFIGURATION"
        | "PROCESS_TIMEOUT"
        | "PROCESS_CANCELLED"
        | "PROCESS_FAILED";
    };

export type VersionProbeFailureReason =
  | "PYTHON_NOT_FOUND"
  | "PYTHON_VERSION_UNSUPPORTED"
  | "WORKSPACE_UNTRUSTED"
  | "PROCESS_TIMEOUT"
  | "PROCESS_CANCELLED"
  | "PROCESS_FAILED";

export type VersionProbeResult =
  | { readonly ok: true; readonly version: ResolvedPython["version"] }
  | {
      readonly ok: false;
      readonly reason: VersionProbeFailureReason;
    };

export interface PythonResolverDependencies {
  readonly isWorkspaceTrusted: () => boolean;
  readonly getPythonExtension: () => vscode.Extension<unknown> | undefined;
  readonly getPythonApi: typeof PythonExtension.api;
  readonly spawn: typeof import("node:child_process").spawn;
  readonly onDidChangeConfiguration: vscode.Event<vscode.ConfigurationChangeEvent>;
  readonly onDidGrantWorkspaceTrust: vscode.Event<void>;
}

export interface PythonResolver extends vscode.Disposable {
  resolve(
    target: SupportedDocument,
    token: vscode.CancellationToken,
  ): Promise<ResolvedPythonResult>;
  invalidate(): void;
}

export const VERSION_ARGUMENTS = [
  "-I",
  "-S",
  "-B",
  "-X",
  "utf8",
  "-c",
  'import sys;print(".".join(map(str,sys.version_info[:3])))',
] as const;
```

- [ ] Write resolver tests first for the exact order: non-empty resource-scoped
  `inlineSql.pythonPath`; selected environment from Microsoft Python Extension API;
  PATH `python3`, then `python` only when the Python extension API is unavailable.
  A configured override that is missing or below 3.12 must fail without falling through.
  A configured override with an invalid type returns `INVALID_CONFIGURATION` with zero
  spawn, Python API, or PATH calls.
  If the Python extension is available but its active environment cannot be resolved,
  assert there is no PATH fallback.
- [ ] Fake the API using its public facade and assert the target resource URI is passed
  to `getActiveEnvironmentPath`.

```ts
const pythonApi = await PythonExtension.api();
await pythonApi.ready;
const active = pythonApi.environments.getActiveEnvironmentPath(target.resourceUri);
const resolved = await pythonApi.environments.resolveEnvironment(active);
const executable = resolved?.executable.uri?.fsPath;
```

- [ ] Add version tests for 3.11 rejection, 3.12.0 acceptance, 3.13, 3.14, malformed
  output, nonzero exit, missing executable, a NUL-containing override that makes spawn
  throw synchronously, cancellation, and a path containing spaces. Assert
  `shell: false`, fixed argument arrays, bounded output, source-free
  `PROCESS_FAILED` for the synchronous throw, and no source/document path in the
  version command. Add a fake-clock case for a silent interpreter:
  at 5,000 ms it is killed exactly once and maps to `PROCESS_TIMEOUT`; cancellation
  and timeout race through one idempotent finish path.

```ts
it("times out a silent version probe", async () => {
  const process = processDouble.neverExits();
  const pending = resolver.resolve(target, token);
  await clock.advanceAsync(5_000);
  await expect(pending).resolves.toMatchObject({
    ok: false,
    reason: "PROCESS_TIMEOUT",
  });
  expect(process.killCalls).toBe(1);
});
```
- [ ] Add trust tests before implementation. In an untrusted workspace, assert no
  configuration override is read, no Python API is called, no PATH lookup occurs, and
  the injected spawn function has zero calls. After a trust grant, resolution works;
  after environment-selection/configuration change, the cache is invalidated.
- [ ] Run and confirm the resolver is missing.

```bash
bun run test:unit -- \
  test/ts/python-resolver.test.ts \
  test/ts/workspace-trust.test.ts
```

- [ ] Implement the bounded version probe first. Check cancellation and trust before
  spawn; use `VERSION_ARGUMENTS`, `shell:false`, and no document-derived cwd or
  argument. Cap stdout and stderr at 4 KiB each, decode with fatal UTF-8, accept only
  `MAJOR.MINOR.PATCH` plus one optional line ending, and kill at 5,000 ms. One
  idempotent `finish()` clears the timer, disposes cancellation, removes listeners,
  and resolves once.

```ts
const VERSION_OUTPUT_LIMIT = 4 * 1024;
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)\r?\n?$/;

async function probeVersion(
  executable: string,
  token: vscode.CancellationToken,
  dependencies: PythonResolverDependencies,
): Promise<VersionProbeResult> {
  if (token.isCancellationRequested) {
    return { ok: false, reason: "PROCESS_CANCELLED" };
  }
  if (!dependencies.isWorkspaceTrusted()) {
    return { ok: false, reason: "WORKSPACE_UNTRUSTED" };
  }
  return new Promise((resolve) => {
    let child: import("node:child_process").ChildProcessWithoutNullStreams;
    try {
      child = dependencies.spawn(executable, [...VERSION_ARGUMENTS], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ ok: false, reason: "PROCESS_FAILED" });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let cancellation: vscode.Disposable = { dispose() {} };
    const finish = (result: VersionProbeResult): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      cancellation.dispose();
      child.removeAllListeners();
      child.stdin.removeAllListeners();
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      resolve(result);
    };
    const terminate = (reason: VersionProbeFailureReason): void => {
      if (settled) return;
      child.kill();
      finish({ ok: false, reason });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > VERSION_OUTPUT_LIMIT) terminate("PROCESS_FAILED");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > VERSION_OUTPUT_LIMIT) terminate("PROCESS_FAILED");
      else stderr.push(chunk);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        reason: error.code === "ENOENT" ? "PYTHON_NOT_FOUND" : "PROCESS_FAILED",
      });
    });
    child.stdin.once("error", () => terminate("PROCESS_FAILED"));
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null || stderrBytes !== 0) {
        finish({ ok: false, reason: "PROCESS_FAILED" });
        return;
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(stdout),
        );
        const match = VERSION_PATTERN.exec(text);
        if (match === null) {
          finish({ ok: false, reason: "PROCESS_FAILED" });
          return;
        }
        const version = {
          major: Number(match[1]),
          minor: Number(match[2]),
          patch: Number(match[3]),
        };
        if (!Object.values(version).every(Number.isSafeInteger)) {
          finish({ ok: false, reason: "PROCESS_FAILED" });
          return;
        }
        finish(
          version.major > 3 || (version.major === 3 && version.minor >= 12)
            ? { ok: true, version }
            : { ok: false, reason: "PYTHON_VERSION_UNSUPPORTED" },
        );
      } catch {
        finish({ ok: false, reason: "PROCESS_FAILED" });
      }
    });
    if (settled) {
      child.removeAllListeners();
      child.stdin.removeAllListeners();
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
    } else {
      timeout = setTimeout(
        () => terminate("PROCESS_TIMEOUT"),
        VERSION_TIMEOUT_MS,
      );
      cancellation = token.onCancellationRequested(() => {
        terminate("PROCESS_CANCELLED");
      });
      if (settled) return;
      try {
        child.stdin.end();
      } catch {
        terminate("PROCESS_FAILED");
      }
    }
  });
}
```

  Timer/cancellation handles have safe defaults, and registration is skipped if a
  synchronous test double already settled the probe; tests cover synchronous `error`
  doubles as well as real asynchronous child-process ordering.

- [ ] Implement one classification wrapper that turns a successful probe into
  `ResolvedPython`, preserves its source, and never exposes executable text in an
  error. A missing configured/API executable is terminal; only PATH `python3`
  `PYTHON_NOT_FOUND` advances to PATH `python`.

```ts
async function resolveExecutable(
  executable: string,
  source: ResolvedPython["source"],
  token: vscode.CancellationToken,
  dependencies: PythonResolverDependencies,
): Promise<ResolvedPythonResult> {
  const probe = await probeVersion(executable, token, dependencies);
  return probe.ok
    ? {
        ok: true,
        python: { executable, version: probe.version, source },
      }
    : { ok: false, reason: probe.reason };
}
```

- [ ] Implement uncached priority resolution. Read the already trust-gated configured
  override first. If `ms-python.python` is installed, await only its public facade,
  call `getActiveEnvironmentPath(target.resourceUri)`, resolve that environment, and
  treat an absent executable/API failure as `PROCESS_FAILED` with no PATH fallback.
  Use PATH only when the extension itself is absent.

```ts
async function resolveUncached(
  target: SupportedDocument,
  configured: string | undefined,
  token: vscode.CancellationToken,
  dependencies: PythonResolverDependencies,
): Promise<ResolvedPythonResult> {
  if (configured !== undefined) {
    return resolveExecutable(configured, "configuration", token, dependencies);
  }
  if (dependencies.getPythonExtension() !== undefined) {
    try {
      const api = await dependencies.getPythonApi();
      await api.ready;
      const active = api.environments.getActiveEnvironmentPath(target.resourceUri);
      const environment = await api.environments.resolveEnvironment(active);
      const executable = environment?.executable.uri?.fsPath;
      return executable === undefined
        ? { ok: false, reason: "PROCESS_FAILED" }
        : resolveExecutable(executable, "python-extension", token, dependencies);
    } catch {
      return { ok: false, reason: "PROCESS_FAILED" };
    }
  }
  const python3 = await resolveExecutable("python3", "path", token, dependencies);
  return !python3.ok && python3.reason === "PYTHON_NOT_FOUND"
    ? resolveExecutable("python", "path", token, dependencies)
    : python3;
}
```

- [ ] Implement `DefaultPythonResolver.resolve()`. Guard trust and cancellation before
  reading configuration, derive the cache key from `resourceUri` plus the normalized
  configured override, and cache only a completed success. Never share a token-bound
  in-flight promise: concurrent invocations have independent processes/cancellation,
  and the first completed success may populate the cache. Before returning any cached
  success, re-check current trust and cancellation. A malformed override returns
  `INVALID_CONFIGURATION` before any API/PATH/spawn call.

```ts
private readonly cache = new Map<string, ResolvedPython>();
private generation = 0;

async resolve(
  target: SupportedDocument,
  token: vscode.CancellationToken,
): Promise<ResolvedPythonResult> {
  if (!this.dependencies.isWorkspaceTrusted()) {
    return { ok: false, reason: "WORKSPACE_UNTRUSTED" };
  }
  if (token.isCancellationRequested) {
    return { ok: false, reason: "PROCESS_CANCELLED" };
  }
  const configured = readConfiguredPythonPath(target.resourceUri);
  if (!configured.ok) return configured;
  const key = `${target.resourceUri.toString()}\0${configured.value ?? ""}`;
  const cached = this.cache.get(key);
  if (cached !== undefined) {
    return { ok: true, python: cached };
  }
  const generation = this.generation;
  const result = await resolveUncached(
    target,
    configured.value,
    token,
    this.dependencies,
  );
  if (!this.dependencies.isWorkspaceTrusted()) {
    return { ok: false, reason: "WORKSPACE_UNTRUSTED" };
  }
  if (token.isCancellationRequested) {
    return { ok: false, reason: "PROCESS_CANCELLED" };
  }
  if (result.ok && generation === this.generation) {
    this.cache.set(key, result.python);
  }
  return result;
}
```

  Add a two-token concurrency test: cancel the first resolution while the second stays
  live. Only the first child is killed; the second succeeds and seeds the completed
  cache. Reversing which token cancels produces the symmetric result.

- [ ] Subscribe to resource configuration changes, trust grant, and the Python API's
  active-environment event once available; each calls `invalidate()`. Store every
  subscription in one `Disposable[]`. `dispose()` clears the cache and disposes each
  subscription exactly once; test two calls to `dispose()` and an environment change
  during an in-flight resolution.

```ts
invalidate(): void {
  this.generation += 1;
  this.cache.clear();
}

dispose(): void {
  if (this.disposed) return;
  this.disposed = true;
  this.invalidate();
  for (const disposable of this.disposables.splice(0)) disposable.dispose();
}
```

- [ ] Keep `@vscode/python-extension` 1.0.5 bundled by esbuild. Do not add
  `extensionDependencies: ["ms-python.python"]`; absence of that extension must preserve
  the approved PATH fallback.
- [ ] Add a second trust guard immediately before each process call, not only at command
  entry. Update manifest trust descriptions and localization. Run a unit test that
  flips trust after API resolution but before the version spawn and asserts zero
  process calls.
- [ ] Run focused tests, manifest tests, bundle syntax check, lint, and types.

```bash
bun run test:unit -- \
  test/ts/python-resolver.test.ts \
  test/ts/workspace-trust.test.ts \
  test/ts/manifest.test.ts
bun run build
node --check dist/extension.js
bun run lint
bun run typecheck
```

- [ ] Commit.

```bash
git add src/vscode/python-resolver.ts test/ts/python-resolver.test.ts \
  test/ts/workspace-trust.test.ts package.json package.nls.json package.nls.ja.json
git commit -m "feat: resolve trusted Python environments"
```

## Task 16: Spawn, cancel, time out, and validate the helper process

**Files:**

- Create: `src/vscode/helper-client.ts`
- Create: `test/ts/helper-client.test.ts`

**Interfaces:**

```ts
export interface DocumentSnapshot {
  readonly uri: vscode.Uri;
  readonly version: number;
  readonly text: string;
}

export interface HelperClient {
  locate(
    snapshot: DocumentSnapshot,
    target: FormatTarget,
    configuration: FormatOptions,
    resource: SupportedDocument,
    token: vscode.CancellationToken,
  ): Promise<LocateResponse>;

  format(
    snapshot: DocumentSnapshot,
    target: FormatTarget,
    configuration: FormatOptions,
    resource: SupportedDocument,
    token: vscode.CancellationToken,
  ): Promise<FormatResponse>;
}

export interface HelperClientDependencies {
  readonly extensionUri: vscode.Uri;
  readonly resolver: PythonResolver;
  readonly isWorkspaceTrusted: () => boolean;
  readonly spawn: typeof import("node:child_process").spawn;
}

export class DefaultHelperClient implements HelperClient {
  constructor(private readonly dependencies: HelperClientDependencies) {}

  locate(
    snapshot: DocumentSnapshot,
    target: FormatTarget,
    configuration: FormatOptions,
    resource: SupportedDocument,
    token: vscode.CancellationToken,
  ): Promise<LocateResponse>;

  format(
    snapshot: DocumentSnapshot,
    target: FormatTarget,
    configuration: FormatOptions,
    resource: SupportedDocument,
    token: vscode.CancellationToken,
  ): Promise<FormatResponse>;
}
```

`DefaultHelperClient` is the sole owner of interpreter resolution for locate/format.
The controller and Code Action provider pass `SupportedDocument` but never resolve an
interpreter themselves. A process-double test asserts one helper call produces exactly
one `resolver.resolve()` call and one version probe, preventing duplicated resolution.

- [ ] Write process-double tests first for exact arguments
  `-I -S -B -X utf8 <bootstrap>`, `shell: false`, request JSON sent once to stdin,
  stdin closed, stdout bounded, stderr bounded and discarded, and one validated response.
  Assert no URI or path is present in the JSON request.
- [ ] Add tests for timeout at exactly five seconds with a fake clock, cancellation
  before spawn, cancellation during execution, spawn error, nonzero exit, signal exit,
  synchronous `stdin.end()` throw, asynchronous stdin error, extra stdout, malformed
  UTF-8/JSON, protocol mismatch, operation mismatch, oversized response, unexpected
  stderr, and response edit text that does not match its declared shape. Every failure
  returns a request-level reason and zero edits; both stdin failures kill a live child
  exactly once.
- [ ] Add privacy assertions with unique source, field, and path sentinels. Failure
  messages and injected notification/log sinks must contain none of them.

```ts
it("kills a helper at the hard timeout and returns no edits", async () => {
  const execution = startNeverEndingProcess();
  const promise = client.format(snapshot, target, options, resource, token);
  await clock.advanceAsync(5_000);
  await expect(promise).resolves.toMatchObject({
    ok: false,
    error: { code: "PROCESS_TIMEOUT" },
  });
  expect(execution.killCalls).toBe(1);
});
```

- [ ] Run and confirm the client is missing.

```bash
bun run test:unit -- test/ts/helper-client.test.ts
```

- [ ] Add source-free response constructors and limits. Map resolver failures without
  interpolation and test every mapping. Construct the protocol request from only
  `snapshot.text`, target, and options; `snapshot.uri`, `resourceUri`, executable, and
  extension paths must never enter serialized JSON.

```ts
const MAX_STDIN_BYTES = 32 * 1024 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const HELPER_TIMEOUT_MS = 5_000;

function requestError(
  operation: ProtocolOperation,
  code: ReasonCode,
): ErrorResponse {
  return {
    protocolVersion: 1,
    operation,
    ok: false,
    error: { code },
  };
}

function helperRequest(
  operation: ProtocolOperation,
  snapshot: DocumentSnapshot,
  target: FormatTarget,
  options: FormatOptions,
): HelperRequest {
  return {
    protocolVersion: 1,
    operation,
    source: snapshot.text,
    target,
    options,
  };
}
```

- [ ] Implement one bounded byte collector used for stdout and stderr. It must reject
  the chunk that crosses its limit without concatenating it, and it must become inert
  after settlement. Unit-test one chunk at the limit, one byte over, and many chunks
  whose sum crosses the limit.

```ts
class BoundedBytes {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): boolean {
    if (this.size + chunk.length > this.limit) return false;
    this.chunks.push(chunk);
    this.size += chunk.length;
    return true;
  }

  get length(): number {
    return this.size;
  }

  concat(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }
}
```

- [ ] Implement spawn with argument arrays and a fixed bootstrap path derived from
  `extensionUri`. Check trust immediately before spawn. Reject stdin above 32 MiB,
  write the compact JSON bytes exactly once, close stdin, cap stdout/stderr, and race
  process close against cancellation and the five-second timer. A synchronous spawn
  throw and an asynchronous `error` event follow the same source-free path.

```ts
type ProcessResult<T> =
  | { readonly ok: true; readonly response: T }
  | { readonly ok: false; readonly code: ReasonCode };

async function runHelperProcess<T extends LocateResponse | FormatResponse>(
  operation: ProtocolOperation,
  requestBytes: Uint8Array,
  resolvedPython: ResolvedPython,
  responseKind: "locateResponse" | "formatResponse",
  dependencies: HelperClientDependencies,
  token: vscode.CancellationToken,
): Promise<ProcessResult<T>> {
  if (requestBytes.byteLength > MAX_STDIN_BYTES) {
    return { ok: false, code: "RESOURCE_LIMIT_EXCEEDED" };
  }
  if (token.isCancellationRequested) {
    return { ok: false, code: "PROCESS_CANCELLED" };
  }
  if (!dependencies.isWorkspaceTrusted()) {
    return { ok: false, code: "WORKSPACE_UNTRUSTED" };
  }
  const extensionRoot = dependencies.extensionUri.fsPath;
  const bootstrapPath = vscode.Uri.joinPath(
    dependencies.extensionUri,
    "python",
    "bootstrap.py",
  ).fsPath;
  let child: import("node:child_process").ChildProcessWithoutNullStreams;
  try {
    child = dependencies.spawn(
      resolvedPython.executable,
      ["-I", "-S", "-B", "-X", "utf8", bootstrapPath],
      {
        cwd: extensionRoot,
        env: process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
  } catch {
    return { ok: false, code: "PROCESS_FAILED" };
  }
  return new Promise((resolve) => {
    const stdout = new BoundedBytes(MAX_STDOUT_BYTES);
    const stderr = new BoundedBytes(MAX_STDERR_BYTES);
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let cancellation: vscode.Disposable = { dispose() {} };
    const finish = (result: ProcessResult<T>): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      cancellation.dispose();
      child.removeAllListeners();
      child.stdin.removeAllListeners();
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      resolve(result);
    };
    const terminate = (code: ReasonCode): void => {
      if (settled) return;
      child.kill();
      finish({ ok: false, code });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (!stdout.push(chunk)) terminate("RESOURCE_LIMIT_EXCEEDED");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!stderr.push(chunk)) terminate("RESOURCE_LIMIT_EXCEEDED");
    });
    child.once("error", () => finish({ ok: false, code: "PROCESS_FAILED" }));
    child.stdin.once("error", () => terminate("PROCESS_FAILED"));
    child.once("close", (exitCode, signal) => {
      if (exitCode !== 0 || signal !== null || stderr.length !== 0) {
        finish({ ok: false, code: "PROCESS_FAILED" });
        return;
      }
      try {
        const jsonText = new TextDecoder("utf-8", { fatal: true }).decode(
          stdout.concat(),
        );
        const response = parseProtocolValue(
          responseKind,
          JSON.parse(jsonText),
        ) as T;
        if (response.operation !== operation) {
          finish({ ok: false, code: "PROTOCOL_ERROR" });
          return;
        }
        finish({ ok: true, response });
      } catch {
        finish({ ok: false, code: "PROTOCOL_ERROR" });
      }
    });
    if (settled) {
      child.removeAllListeners();
      child.stdin.removeAllListeners();
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      return;
    }
    timeout = setTimeout(
      () => terminate("PROCESS_TIMEOUT"),
      HELPER_TIMEOUT_MS,
    );
    cancellation = token.onCancellationRequested(() => {
      terminate("PROCESS_CANCELLED");
    });
    if (settled) return;
    try {
      child.stdin.end(Buffer.from(requestBytes));
    } catch {
      terminate("PROCESS_FAILED");
    }
  });
}
```

- [ ] Keep the exact process construction in a focused assertion:

```ts
const child = spawn(
  resolvedPython.executable,
  ["-I", "-S", "-B", "-X", "utf8", bootstrapPath],
  {
    cwd: extensionRoot,
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  },
);
child.stdin.end(requestBytes);
```

  Isolated Python flags provide import isolation; retaining the environment preserves
  platform runtime variables, and tests prove hostile `PYTHONPATH` is ignored.

- [ ] Implement one `invoke()` path shared by `locate()` and `format()`. Resolve the
  interpreter exactly once, perform a fresh trust/cancellation check after resolution,
  serialize once, invoke one process, and convert process failures into an
  operation-matching `ErrorResponse`. `locate()` and `format()` only narrow the return
  type and do not duplicate orchestration.

```ts
private async invoke(
  operation: ProtocolOperation,
  snapshot: DocumentSnapshot,
  target: FormatTarget,
  configuration: FormatOptions,
  resource: SupportedDocument,
  token: vscode.CancellationToken,
): Promise<LocateResponse | FormatResponse> {
  const resolution = await this.dependencies.resolver.resolve(resource, token);
  if (!resolution.ok) return requestError(operation, resolution.reason);
  if (token.isCancellationRequested) {
    return requestError(operation, "PROCESS_CANCELLED");
  }
  if (!this.dependencies.isWorkspaceTrusted()) {
    return requestError(operation, "WORKSPACE_UNTRUSTED");
  }
  const requestBytes = serializeRequest(
    helperRequest(operation, snapshot, target, configuration),
  );
  const result = await runHelperProcess(
    operation,
    requestBytes,
    resolution.python,
    operation === "locate" ? "locateResponse" : "formatResponse",
    this.dependencies,
    token,
  );
  return result.ok
    ? result.response
    : requestError(operation, result.code);
}

locate(
  snapshot: DocumentSnapshot,
  target: FormatTarget,
  configuration: FormatOptions,
  resource: SupportedDocument,
  token: vscode.CancellationToken,
): Promise<LocateResponse> {
  return this.invoke(
    "locate",
    snapshot,
    target,
    configuration,
    resource,
    token,
  ) as Promise<LocateResponse>;
}

format(
  snapshot: DocumentSnapshot,
  target: FormatTarget,
  configuration: FormatOptions,
  resource: SupportedDocument,
  token: vscode.CancellationToken,
): Promise<FormatResponse> {
  return this.invoke(
    "format",
    snapshot,
    target,
    configuration,
    resource,
    token,
  ) as Promise<FormatResponse>;
}
```

- [ ] Validate all helper output through `src/protocol.ts`. Map timeout, cancel, spawn,
  exit, and protocol failure to the stable taxonomy. Never retry automatically or
  apply partial output from a failed process. Run property tests that arbitrary stdout,
  stderr, signal, and event order always settle once and never throw from an event
  callback.
- [ ] Run client, resolver, protocol, lint, and type tests.

```bash
bun run test:unit -- \
  test/ts/helper-client.test.ts \
  test/ts/python-resolver.test.ts \
  test/ts/protocol.test.ts
bun run lint
bun run typecheck
```

- [ ] Commit.

```bash
git add src/vscode/helper-client.ts test/ts/helper-client.test.ts
git commit -m "feat: run the isolated formatting helper"
```

## Task 17: Apply atomic edits and orchestrate formatting

**Files:**

- Create: `src/vscode/edit-applicator.ts`
- Create: `src/vscode/notifications.ts`
- Create: `src/vscode/format-controller.ts`
- Create: `src/vscode/test-hooks.ts`
- Modify: `src/vscode/helper-client.ts`
- Modify: `src/vscode/python-resolver.ts`
- Create: `test/ts/edit-applicator.test.ts`
- Create: `test/ts/format-controller.test.ts`
- Modify: `test/ts/helper-client.test.ts`
- Modify: `test/ts/python-resolver.test.ts`

**Interfaces:**

```ts
export type ApplyOutcome =
  | { readonly ok: true; readonly applied: number }
  | {
      readonly ok: false;
      readonly reason:
        | "DOCUMENT_CHANGED"
        | "APPLY_EDIT_FAILED"
        | "PROTOCOL_ERROR"
        | "PROCESS_CANCELLED"
        | "WORKSPACE_UNTRUSTED";
    };

export interface ApplyGuard {
  readonly token: vscode.CancellationToken;
  readonly isWorkspaceTrusted: () => boolean;
}

export interface EditApplicator {
  apply(
    document: vscode.TextDocument,
    snapshot: DocumentSnapshot,
    response: FormatSuccess,
    guard: ApplyGuard,
  ): Promise<ApplyOutcome>;
}

export interface FormatInvocation {
  readonly documentUri?: vscode.Uri;
  readonly range?: vscode.Range;
}

export interface FormatController {
  execute(
    mode: FormatMode,
    invocation?: FormatInvocation,
  ): Promise<void>;
}

export interface IntegrationTestHooks {
  readonly processWillSpawn: (kind: "version" | "helper") => void;
  readonly afterHelperResponse: (cancelOperation: () => void) => Promise<void>;
  readonly isWorkspaceTrusted: (actualTrust: boolean) => boolean;
  readonly applyWorkspaceEdit: (edit: vscode.WorkspaceEdit) => Thenable<boolean>;
  readonly operationCompleted: (outcome: TestOperationOutcome) => void;
}

export interface TestOperationOutcome {
  readonly changed: number;
  readonly skipped: number;
  readonly reason?: ReasonCode;
}
```

- [ ] Write applicator tests first. Reject a changed document version, expected-text
  mismatch, invalid UTF-16 position, out-of-bounds range, overlapping edits, duplicate
  ranges, an empty range/empty `expectedText`, and a range whose end is beyond the
  current document. `FormatEdit` has no URI, so document membership is established by
  applying every protocol range only to the `document` argument. Assert validation
  completes before constructing a `WorkspaceEdit`.
- [ ] For a valid multi-edit response, assert all replacements are added to one
  `WorkspaceEdit`, `workspace.applyEdit()` is called exactly once, and `false` maps to
  `APPLY_EDIT_FAILED` without retry. Confirm one undo restores the entire operation in
  integration later.
- [ ] Add deterministic tests that pause immediately after a successful helper response,
  then cancel the operation or revoke Workspace Trust before apply. In both cases
  `workspace.applyEdit()` must have zero calls and the result must be
  `PROCESS_CANCELLED` or `WORKSPACE_UNTRUSTED`.
- [ ] Implement disabled-by-default hooks. Only when
  `context.extensionMode === vscode.ExtensionMode.Test`, register unmanifested commands
  `inlineSql.test.configureHooks`, `inlineSql.test.releaseBeforeApply`, and
  `inlineSql.test.readHooks`. Their fixed state supports `pauseBeforeApply`,
  `cancelAtBarrier`, `workspaceTrustOverride`, `forcedApplyResult`, and counts
  `version`/`helper` spawn attempts. Production mode always uses immediate continuation,
  actual `workspace.isTrusted`, real `workspace.applyEdit`, and no test commands.
- [ ] Thread `IntegrationTestHooks.processWillSpawn` into the resolver and helper
  dependency objects. Invoke it immediately after the final trust check and immediately
  before the corresponding `spawn()` call; never invoke it for a cache hit, rejected
  configuration, untrusted operation, or cancelled operation. This is the sole
  integration-process sentinel.
- [ ] Write controller tests for cursor, selection, and all target construction;
  empty selection guidance; no active/focused cell; invalid configuration; untrusted
  workspace; unsupported document; Python failure; helper error; no candidate;
  unchanged; one changed candidate with no notification; all skipped; and partial
  success count summary.
- [ ] Verify every user message is selected from reason code and counts only. Inject
  SQL, f-string, and path sentinels and assert none appears in notifications.

```ts
it("applies safe partial success in one workspace edit", async () => {
  const response = formatSuccess({
    edits: [firstEdit, secondEdit],
    skips: [unsafeRawSkip],
  });
  const outcome = await applicator.apply(document, snapshot, response, trustedGuard);
  expect(outcome).toEqual({ ok: true, applied: 2 });
  expect(workspace.applyEdit).toHaveBeenCalledTimes(1);
});
```

- [ ] Run and confirm the modules are absent.

```bash
bun run test:unit -- \
  test/ts/edit-applicator.test.ts \
  test/ts/format-controller.test.ts
```

- [ ] Implement strict protocol-position conversion without relying on the clamping
  behavior of `TextDocument.offsetAt()`. Reject a line/character outside the document
  and a UTF-16 boundary between a high and low surrogate. Test LF, CRLF, empty final
  line, non-BMP text before both endpoints, and malicious surrogate-interior offsets.

```ts
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function strictPosition(
  document: vscode.TextDocument,
  value: Position,
): vscode.Position | undefined {
  if (value.line < 0 || value.line >= document.lineCount) return undefined;
  const line = document.lineAt(value.line).text;
  if (value.character < 0 || value.character > line.length) return undefined;
  if (
    value.character > 0 &&
    value.character < line.length &&
    isHighSurrogate(line.charCodeAt(value.character - 1)) &&
    isLowSurrogate(line.charCodeAt(value.character))
  ) {
    return undefined;
  }
  return new vscode.Position(value.line, value.character);
}
```

- [ ] Implement complete preflight validation against snapshot URI/version/text,
  declared `expectedText`, unique ranges, and pairwise non-overlap. Convert all ranges
  and compute offsets into an immutable list before constructing `WorkspaceEdit`.
  Adjacent edits are valid; duplicate or intersecting edits are not.

```ts
interface ValidatedEdit {
  readonly range: vscode.Range;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly newText: string;
}

function validateEdits(
  document: vscode.TextDocument,
  snapshot: DocumentSnapshot,
  response: FormatSuccess,
): readonly ValidatedEdit[] | undefined {
  if (
    document.uri.toString() !== snapshot.uri.toString() ||
    document.version !== snapshot.version ||
    document.getText() !== snapshot.text
  ) {
    return undefined;
  }
  const seen = new Set<string>();
  const validated: ValidatedEdit[] = [];
  for (const edit of response.edits) {
    const start = strictPosition(document, edit.range.start);
    const end = strictPosition(document, edit.range.end);
    if (
      start === undefined ||
      end === undefined ||
      start.isAfterOrEqual(end) ||
      edit.expectedText.length === 0
    ) {
      return undefined;
    }
    const range = new vscode.Range(start, end);
    const key = `${start.line}:${start.character}-${end.line}:${end.character}`;
    if (seen.has(key) || document.getText(range) !== edit.expectedText) {
      return undefined;
    }
    seen.add(key);
    validated.push({
      range,
      startOffset: document.offsetAt(start),
      endOffset: document.offsetAt(end),
      newText: edit.newText,
    });
  }
  validated.sort((left, right) => left.startOffset - right.startOffset);
  for (let index = 1; index < validated.length; index += 1) {
    if (validated[index]!.startOffset < validated[index - 1]!.endOffset) {
      return undefined;
    }
  }
  return validated;
}
```

- [ ] Implement `DefaultEditApplicator.apply()`. Map changed snapshots to
  `DOCUMENT_CHANGED`; map malformed helper ranges/text to `PROTOCOL_ERROR`. Create
  exactly one `WorkspaceEdit` only after validation, then immediately before
  `applyWorkspaceEdit()` check cancellation and trust. Add every replacement to the
  snapshot document URI and invoke apply exactly once.

```ts
async apply(
  document: vscode.TextDocument,
  snapshot: DocumentSnapshot,
  response: FormatSuccess,
  guard: ApplyGuard,
): Promise<ApplyOutcome> {
  if (
    document.uri.toString() !== snapshot.uri.toString() ||
    document.version !== snapshot.version ||
    document.getText() !== snapshot.text
  ) {
    return { ok: false, reason: "DOCUMENT_CHANGED" };
  }
  const edits = validateEdits(document, snapshot, response);
  if (edits === undefined) return { ok: false, reason: "PROTOCOL_ERROR" };
  if (guard.token.isCancellationRequested) {
    return { ok: false, reason: "PROCESS_CANCELLED" };
  }
  if (!guard.isWorkspaceTrusted()) {
    return { ok: false, reason: "WORKSPACE_UNTRUSTED" };
  }
  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const edit of edits) {
    workspaceEdit.replace(document.uri, edit.range, edit.newText);
  }
  const applied = await this.hooks.applyWorkspaceEdit(workspaceEdit);
  return applied
    ? { ok: true, applied: edits.length }
    : { ok: false, reason: "APPLY_EDIT_FAILED" };
}
```

- [ ] Implement test hooks as one production-safe adapter. `createTestHooks(context)`
  returns immutable production hooks unless `extensionMode === Test`; only then does
  it register the three unmanifested test commands and expose a resettable barrier.
  `readHooks({waitForBarrier: true})` is an event-driven wait resolved by
  `afterHelperResponse`; the ordinary no-argument form remains an immediate snapshot.
  The controller calls `operationCompleted()` exactly once from the same source-free
  branch that selects the user notification. Its test-only snapshot contains only
  `changed`, `skipped`, and optional reason code, allowing integration tests to prove a
  partial-success summary without exposing source text.
  Test production mode by attempting every test command and confirming it is absent.
  Dispose and release any pending barrier during deactivation so the test host cannot
  hang.

```ts
export function createTestHooks(
  context: vscode.ExtensionContext,
): IntegrationTestHooks {
  if (context.extensionMode !== vscode.ExtensionMode.Test) {
    return {
      processWillSpawn: () => {},
      afterHelperResponse: async () => {},
      isWorkspaceTrusted: (actual) => actual,
      applyWorkspaceEdit: (edit) => vscode.workspace.applyEdit(edit),
      operationCompleted: () => {},
    };
  }
  return createEnabledTestHooks(context);
}

interface TestHookConfiguration {
  readonly pauseBeforeApply?: boolean;
  readonly cancelAtBarrier?: boolean;
  readonly workspaceTrustOverride?: boolean;
  readonly forcedApplyResult?: boolean;
}

interface ReadHookOptions {
  readonly waitForBarrier?: boolean;
}

function createEnabledTestHooks(
  context: vscode.ExtensionContext,
): IntegrationTestHooks {
  let configuration: TestHookConfiguration = {};
  let barrierReached = false;
  let releaseBarrier: (() => void) | undefined;
  const barrierWaiters = new Set<() => void>();
  const spawnCounts = { version: 0, helper: 0 };
  let lastOutcome: TestOperationOutcome | undefined;
  const hooks: IntegrationTestHooks = {
    processWillSpawn(kind) {
      spawnCounts[kind] += 1;
    },
    async afterHelperResponse(cancelOperation) {
      if (!configuration.pauseBeforeApply) return;
      barrierReached = true;
      for (const resolve of barrierWaiters) resolve();
      barrierWaiters.clear();
      if (configuration.cancelAtBarrier) cancelOperation();
      await new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      barrierReached = false;
      releaseBarrier = undefined;
    },
    isWorkspaceTrusted(actualTrust) {
      return configuration.workspaceTrustOverride ?? actualTrust;
    },
    applyWorkspaceEdit(edit) {
      return configuration.forcedApplyResult === undefined
        ? vscode.workspace.applyEdit(edit)
        : Promise.resolve(configuration.forcedApplyResult);
    },
    operationCompleted(outcome) {
      lastOutcome = { ...outcome };
    },
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "inlineSql.test.configureHooks",
      (value: TestHookConfiguration) => {
        configuration = { ...value };
        lastOutcome = undefined;
      },
    ),
    vscode.commands.registerCommand("inlineSql.test.releaseBeforeApply", () => {
      releaseBarrier?.();
    }),
    vscode.commands.registerCommand(
      "inlineSql.test.readHooks",
      async (options?: ReadHookOptions) => {
        if (options?.waitForBarrier === true && !barrierReached) {
          await new Promise<void>((resolve) => {
            barrierWaiters.add(resolve);
          });
        }
        return {
          barrierReached,
          spawnCounts: { ...spawnCounts },
          lastOutcome,
        };
      },
    ),
    {
      dispose() {
        releaseBarrier?.();
        releaseBarrier = undefined;
        for (const resolve of barrierWaiters) resolve();
        barrierWaiters.clear();
      },
    },
  );
  return hooks;
}
```

- [ ] Implement target construction as a pure function. Cursor uses the active
  position, selection rejects an empty range, and all has no coordinates. For a Code
  Action invocation, resolve `documentUri` against current visible editors and require
  the routed editor still owns the supplied range; never fall back to a different
  active document.

```ts
function resolveInvocationOrActiveTarget(
  invocation: FormatInvocation | undefined,
): TargetResolution {
  if (invocation?.documentUri === undefined) {
    return resolveActiveEditorTarget();
  }
  const editor = vscode.window.visibleTextEditors.find(
    (candidate) =>
      candidate.document.uri.toString() === invocation.documentUri?.toString(),
  );
  if (editor === undefined) {
    return { ok: false, reason: "NO_ACTIVE_EDITOR" };
  }
  if (
    invocation.range !== undefined &&
    !editor.document.validateRange(invocation.range).isEqual(invocation.range)
  ) {
    return { ok: false, reason: "UNSUPPORTED_DOCUMENT" };
  }
  return resolveEditorTarget(editor);
}

function protocolTarget(
  mode: FormatMode,
  editor: vscode.TextEditor,
  invocation?: FormatInvocation,
): FormatTarget | undefined {
  const selected = invocation?.range ?? editor.selection;
  if (mode === "all") return { mode: "all" };
  if (mode === "cursor") {
    const cursor = invocation?.range?.start ?? editor.selection.active;
    return {
      mode: "cursor",
      cursor: { line: cursor.line, character: cursor.character },
    };
  }
  if (selected.isEmpty) return undefined;
  return {
    mode: "selection",
    selection: {
      start: {
        line: selected.start.line,
        character: selected.start.character,
      },
      end: { line: selected.end.line, character: selected.end.character },
    },
  };
}
```

  Add a backward selection whose `active` endpoint differs from `start`; the normal
  cursor command must use `selection.active`. A routed Code Action with an empty range
  must use that range's start.

- [ ] Implement controller order: trust → target → configuration → size precheck →
  helper (which resolves the interpreter exactly once) →
  unchanged/error/partial result → final cancel/trust guard → preflight/apply →
  notification. The controller must not call `PythonResolver` separately, which would
  duplicate the version probe. If a success has zero edits, notify unchanged or skipped
  counts and return without calling the applicator. Use a cancellable VS Code progress
  token for every formatting command. Snapshot source and version before asynchronous
  work. Do not log source.

```ts
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

private async runFormatting(
  mode: FormatMode,
  invocation: FormatInvocation | undefined,
  token: vscode.CancellationToken,
  cancelOperation: () => void,
): Promise<void> {
  if (!this.hooks.isWorkspaceTrusted(vscode.workspace.isTrusted)) {
    return this.notifications.reason("WORKSPACE_UNTRUSTED");
  }
  const resolution = resolveInvocationOrActiveTarget(invocation);
  if (!resolution.ok) return this.notifications.target(resolution.reason);
  const { target: resource, editor } = resolution;
  const options = readFormatOptions(resource.resourceUri);
  if (!options.ok) return this.notifications.reason(options.reason);
  const protocol = protocolTarget(mode, editor, invocation);
  if (protocol === undefined) return this.notifications.emptySelection();
  const text = resource.document.getText();
  if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) {
    return this.notifications.reason("RESOURCE_LIMIT_EXCEEDED");
  }
  const snapshot: DocumentSnapshot = {
    uri: resource.documentUri,
    version: resource.document.version,
    text,
  };
  const response = await this.helper.format(
    snapshot,
    protocol,
    options.options,
    resource,
    token,
  );
  await this.hooks.afterHelperResponse(cancelOperation);
  if (!response.ok) return this.notifications.reason(response.error.code);
  if (response.edits.length === 0) {
    this.hooks.operationCompleted({
      changed: response.summary.changed,
      skipped: response.summary.skipped,
    });
    return this.notifications.summary(response.summary, response.skips.length);
  }
  const outcome = await this.applicator.apply(
    resource.document,
    snapshot,
    response,
    {
      token,
      isWorkspaceTrusted: () =>
        this.hooks.isWorkspaceTrusted(vscode.workspace.isTrusted),
    },
  );
  if (!outcome.ok) return this.notifications.reason(outcome.reason);
  this.hooks.operationCompleted({
    changed: response.summary.changed,
    skipped: response.summary.skipped,
  });
  if (response.skips.length > 0) {
    this.notifications.summary(response.summary, response.skips.length);
  }
}

async execute(mode: FormatMode, invocation?: FormatInvocation): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Formatting inline SQL",
      cancellable: true,
    },
    async (_progress, progressToken) => {
      const operation = new vscode.CancellationTokenSource();
      const cancellation = progressToken.onCancellationRequested(() => {
        operation.cancel();
      });
      try {
        await this.runFormatting(
          mode,
          invocation,
          operation.token,
          () => operation.cancel(),
        );
      } finally {
        cancellation.dispose();
        operation.dispose();
      }
    },
  );
}
```

  The controller owns one `CancellationTokenSource` per invocation, composes it with
  the progress token, exposes only its cancel callback to test hooks, and disposes both
  registrations in `finally`.

- [ ] Implement `notifications.ts` as an exhaustive switch from reason/target codes and
  numeric summaries to fixed localized strings. It accepts no source, path, exception,
  or arbitrary message parameter. Unit-test that every `ReasonCode` is handled and an
  `assertNever()` catches additions at compile time.

```ts
export function reasonMessage(code: ReasonCode): string {
  switch (code) {
    case "PYTHON_NOT_FOUND":
      return vscode.l10n.t("Install Python 3.12 or later, or configure inlineSql.pythonPath.");
    case "PYTHON_VERSION_UNSUPPORTED":
      return vscode.l10n.t("Inline SQL formatting requires Python 3.12 or later.");
    case "WORKSPACE_UNTRUSTED":
      return vscode.l10n.t("Inline SQL formatting requires a trusted workspace.");
    case "INVALID_CONFIGURATION":
      return vscode.l10n.t("An Inline SQL setting has an invalid value.");
    case "DOCUMENT_PARSE_FAILED":
      return vscode.l10n.t("The current Python document could not be parsed.");
    case "NO_SQL_CANDIDATE":
      return vscode.l10n.t("No inline SQL candidate was found.");
    case "UNSUPPORTED_LITERAL":
      return vscode.l10n.t("The selected SQL uses an unsupported Python literal shape.");
    case "UNSAFE_FSTRING_RESTORE":
      return vscode.l10n.t("Formatting was skipped because an f-string could not be restored safely.");
    case "UNSAFE_RAW_STRING":
      return vscode.l10n.t("Formatting was skipped because a raw string could not be preserved safely.");
    case "FORMATTER_FAILED":
      return vscode.l10n.t("The SQL formatter could not format the selected candidate.");
    case "RESOURCE_LIMIT_EXCEEDED":
      return vscode.l10n.t("The document or formatting result exceeded a safety limit.");
    case "PROCESS_TIMEOUT":
      return vscode.l10n.t("The Inline SQL helper timed out.");
    case "PROCESS_CANCELLED":
      return vscode.l10n.t("Inline SQL formatting was cancelled.");
    case "PROCESS_FAILED":
      return vscode.l10n.t("The Inline SQL helper failed.");
    case "DOCUMENT_CHANGED":
      return vscode.l10n.t("The document changed before formatting could be applied.");
    case "APPLY_EDIT_FAILED":
      return vscode.l10n.t("VS Code could not apply the Inline SQL edit.");
    case "PROTOCOL_ERROR":
      return vscode.l10n.t("The Inline SQL helper returned an invalid response.");
    default:
      return assertNever(code);
  }
}
```
- [ ] Run focused and dependency tests with quality checks.

```bash
bun run test:unit -- \
  test/ts/edit-applicator.test.ts \
  test/ts/format-controller.test.ts \
  test/ts/helper-client.test.ts \
  test/ts/document-target.test.ts
bun run lint
bun run typecheck
```

- [ ] Commit.

```bash
git add src/vscode/edit-applicator.ts src/vscode/notifications.ts \
  src/vscode/format-controller.ts src/vscode/test-hooks.ts \
  src/vscode/helper-client.ts src/vscode/python-resolver.ts \
  test/ts/edit-applicator.test.ts test/ts/format-controller.test.ts \
  test/ts/helper-client.test.ts test/ts/python-resolver.test.ts
git commit -m "feat: apply verified inline SQL edits atomically"
```

## Task 18: Register commands, Code Action, and extension lifecycle

**Files:**

- Create: `src/vscode/commands.ts`
- Create: `src/vscode/code-actions.ts`
- Modify: `src/extension.ts`
- Create: `test/ts/code-actions.test.ts`
- Modify: `test/ts/manifest.test.ts`
- Modify: `package.json`
- Modify: `package.nls.json`
- Modify: `package.nls.ja.json`

**Interfaces:**

```ts
export function registerCommands(
  context: vscode.ExtensionContext,
  controller: FormatController,
): void;

export class InlineSqlCodeActionProvider
  implements vscode.CodeActionProvider
{
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.RefactorRewrite];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<readonly vscode.CodeAction[]>;
}

export function activate(context: vscode.ExtensionContext): void;
export function deactivate(): void;

export interface CodeActionDependencies {
  readonly helper: HelperClient;
  readonly isWorkspaceTrusted: () => boolean;
}
```

- [ ] Write command registration tests first. Assert exactly the three approved command
  IDs are publicly contributed and call the shared controller with cursor, selection,
  or all mode. Test-only hook commands are permitted only under `ExtensionMode.Test`
  and must not appear in `package.json`. Assert no text
  document formatting provider, range formatting provider, save listener, type listener,
  status bar item, keybinding contribution, or SQL execution command is registered.
- [ ] Write Code Action tests for trusted supported documents where locate reports a
  candidate intersecting cursor/range. Assert title `Format inline SQL`, kind
  `refactor.rewrite`, and command routing through the same controller. An empty editor
  range uses cursor mode; a non-empty range uses selection mode and still expands only
  to complete literal units. The returned command argument is
  `{ documentUri: document.uri, range }`; the provider never assumes that an editor is
  available through the Code Action API.
- [ ] Add negative cases for untrusted workspace, unsupported language/notebook,
  cancellation, parse failure, no candidate, and non-intersecting range. Assert the
  provider starts no process while untrusted.
- [ ] Start an integration-style unit test untrusted, fire
  `workspace.onDidGrantWorkspaceTrust`, and assert the Code Action provider is
  registered exactly once without reloading the extension. Commands remain registered
  throughout and rely on the same runtime trust guards.
- [ ] Add a cache test: locate results may be cached only by document URI and version
  while constructing action lists. The provider always locates with
  `target: { mode: "all" }`, caches only a completed successful result, and intersects
  each requested cursor/range locally. Two sequential different ranges at the same
  URI/version cause one locate call; a version change causes another. Do not cache an
  in-flight token-bound promise or a failure. Executing the action must call `format`
  again with a fresh snapshot; cached ranges or edits can never be applied.

```ts
it("routes an action by document URI without retaining locate output", async () => {
  const actions = await provider.provideCodeActions(
    document,
    range,
    codeActionContext,
    token,
  );
  expect(actions).toHaveLength(1);
  expect(helper.locateCalls).toBe(1);
  expect(actions[0]?.command?.arguments).toEqual([
    { documentUri: document.uri, range },
  ]);
  expect(controller.executeCalls).toHaveLength(0);
  expect(helper.formatCalls).toBe(0);
});

it("re-runs formatting when the routed command is executed", async () => {
  await executeControllerCommand({ documentUri: document.uri, range });
  expect(controller.executeCalls).toEqual([
    {
      mode: "selection",
      invocation: { documentUri: document.uri, range },
    },
  ]);
  expect(helper.formatCalls).toBe(1);
});
```

- [ ] Run and confirm failures because activation and provider are absent.

```bash
bun run test:unit -- \
  test/ts/code-actions.test.ts \
  test/ts/manifest.test.ts
```

- [ ] Implement the three public command handlers as a fixed table. Each accepts only
  the optional `FormatInvocation` supplied by this extension's Code Action and delegates
  once to the shared controller. Push all command disposables to
  `context.subscriptions`.

```ts
export const COMMANDS = {
  cursor: "inlineSql.formatAtCursor",
  selection: "inlineSql.formatSelection",
  all: "inlineSql.formatAll",
} as const;

export function registerCommands(
  context: vscode.ExtensionContext,
  controller: FormatController,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      COMMANDS.cursor,
      (invocation?: FormatInvocation) =>
        controller.execute("cursor", invocation),
    ),
    vscode.commands.registerCommand(
      COMMANDS.selection,
      (invocation?: FormatInvocation) =>
        controller.execute("selection", invocation),
    ),
    vscode.commands.registerCommand(
      COMMANDS.all,
      (invocation?: FormatInvocation) =>
        controller.execute("all", invocation),
    ),
  );
}
```

- [ ] Implement a bounded completed-success-only locate cache. Store immutable
  candidate ranges by document URI/version after locate resolves; never store an
  in-flight promise, failure, edit text, options, requested range, or skips. Limit the
  cache to 32 entries with oldest-entry eviction.

```ts
class LocateCache {
  private readonly values = new Map<string, readonly TextRange[]>();

  get(uri: vscode.Uri, version: number): readonly TextRange[] | undefined {
    return this.values.get(`${uri.toString()}\0${version}`);
  }

  set(uri: vscode.Uri, version: number, ranges: readonly TextRange[]): void {
    const key = `${uri.toString()}\0${version}`;
    this.values.delete(key);
    this.values.set(key, Object.freeze([...ranges]));
    if (this.values.size > 32) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest !== undefined) this.values.delete(oldest);
    }
  }

  deleteUri(uri: vscode.Uri): void {
    const prefix = `${uri.toString()}\0`;
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) this.values.delete(key);
    }
  }

  clear(): void {
    this.values.clear();
  }
}
```

- [ ] Implement provider preflight: current trust, supported notebook/document
  membership, resource-scoped options, cancellation, and the 5 MiB UTF-8 cap. On a
  miss, locate with a fresh snapshot and `{mode:"all"}`. Cache only `ok:true` after
  confirming the token, trust, and document version are still current; clear the URI
  entry on every helper failure.

```ts
private async locateCandidates(
  document: vscode.TextDocument,
  token: vscode.CancellationToken,
): Promise<readonly TextRange[] | undefined> {
  if (token.isCancellationRequested || !this.dependencies.isWorkspaceTrusted()) {
    return undefined;
  }
  const resource = resolveSupportedDocument(
    document,
    vscode.workspace.notebookDocuments,
  );
  if (resource === undefined) return undefined;
  const options = readFormatOptions(resource.resourceUri);
  if (!options.ok) return undefined;
  const text = document.getText();
  if (Buffer.byteLength(text, "utf8") > 5 * 1024 * 1024) return undefined;
  const cached = this.cache.get(document.uri, document.version);
  if (cached !== undefined) return cached;
  const version = document.version;
  const response = await this.dependencies.helper.locate(
    { uri: document.uri, version, text },
    { mode: "all" },
    options.options,
    resource,
    token,
  );
  if (
    !response.ok ||
    token.isCancellationRequested ||
    document.version !== version ||
    !this.dependencies.isWorkspaceTrusted()
  ) {
    this.cache.deleteUri(document.uri);
    return undefined;
  }
  this.cache.set(document.uri, version, response.candidates);
  return response.candidates;
}
```

- [ ] Convert returned protocol positions with Task 17's strict UTF-16 guard and
  intersect locally. A malformed range clears the cache and produces no action.
  Use the helper's half-open rules explicitly: `candidate.start <= cursor <
  candidate.end`, and strict overlap for selections. Candidate-end cursor and
  endpoint-only selection contact are negative tests. Return at most one action and
  route it with `{documentUri, range}` only.

```ts
async provideCodeActions(
  document: vscode.TextDocument,
  range: vscode.Range,
  _context: vscode.CodeActionContext,
  token: vscode.CancellationToken,
): Promise<readonly vscode.CodeAction[]> {
  const candidates = await this.locateCandidates(document, token);
  if (candidates === undefined) return [];
  let malformed = false;
  const intersects = candidates.some((candidate) => {
    const start = strictPosition(document, candidate.start);
    const end = strictPosition(document, candidate.end);
    if (start === undefined || end === undefined || start.isAfterOrEqual(end)) {
      malformed = true;
      return false;
    }
    const candidateRange = new vscode.Range(start, end);
    return range.isEmpty
      ? !range.start.isBefore(candidateRange.start) &&
          range.start.isBefore(candidateRange.end)
      : candidateRange.start.isBefore(range.end) &&
          range.start.isBefore(candidateRange.end);
  });
  if (malformed) this.cache.deleteUri(document.uri);
  if (
    malformed ||
    !intersects ||
    token.isCancellationRequested ||
    !this.dependencies.isWorkspaceTrusted()
  ) {
    return [];
  }
  const action = new vscode.CodeAction(
    "Format inline SQL",
    vscode.CodeActionKind.RefactorRewrite,
  );
  action.command = {
    title: "Format inline SQL",
    command: range.isEmpty ? COMMANDS.cursor : COMMANDS.selection,
    arguments: [{ documentUri: document.uri, range }],
  };
  return [action];
}
```

- [ ] Implement activation composition and disposables. Construct one hooks adapter,
  resolver, helper, applicator, controller, provider, and cache, and register commands
  unconditionally. Register Code Actions with `INLINE_SQL_SELECTOR`, retaining Task
  14's runtime notebook membership guards. When a routed command carries
  `documentUri`, Task 17 resolves it against current visible editors and fails safely
  instead of falling back to another active document.

```ts
function registerCodeActionsOnce(
  context: vscode.ExtensionContext,
  provider: InlineSqlCodeActionProvider,
  state: { provider: vscode.Disposable | undefined },
): void {
  if (state.provider !== undefined) return;
  state.provider = vscode.languages.registerCodeActionsProvider(
    INLINE_SQL_SELECTOR,
    provider,
    {
      providedCodeActionKinds:
        InlineSqlCodeActionProvider.providedCodeActionKinds,
    },
  );
  context.subscriptions.push(state.provider);
}
```

- [ ] Wire document change/close to `cache.deleteUri`. Register the provider immediately
  only when trusted; otherwise register it from a one-shot trust-grant listener.
  On grant, clear the locate cache and invalidate interpreter resolution first.
  Keep provider registration idempotent and continue checking live trust inside the
  provider and at every process/apply boundary.

```ts
const registrationState: { provider: vscode.Disposable | undefined } = {
  provider: undefined,
};
let trustGrant: vscode.Disposable | undefined;
if (vscode.workspace.isTrusted) {
  registerCodeActionsOnce(context, provider, registrationState);
} else {
  trustGrant = vscode.workspace.onDidGrantWorkspaceTrust(() => {
    cache.clear();
    resolver.invalidate();
    registerCodeActionsOnce(context, provider, registrationState);
    trustGrant?.dispose();
    trustGrant = undefined;
  });
  context.subscriptions.push(trustGrant);
}
context.subscriptions.push(
  vscode.workspace.onDidChangeTextDocument((event) => {
    cache.deleteUri(event.document.uri);
  }),
  vscode.workspace.onDidCloseTextDocument((document) => {
    cache.deleteUri(document.uri);
  }),
);
```

- [ ] Make lifecycle state idempotent in tests. A module-level disposable owns only
  module state that VS Code does not own; `deactivate()` disposes it once and clears
  the reference. A second test activation first tears down the old module state and
  still observes exactly one provider. Never manually dispose
  `context.subscriptions` during normal activation.
- [ ] Complete localized command/configuration descriptions. Keep command titles in the
  approved English form and supply Japanese descriptions without changing IDs.
- [ ] Run every unit test, bundle, inspect CJS syntax, lint, and typecheck.

```bash
bun run test:unit
bun run build
node --check dist/extension.js
bun run lint
bun run typecheck
```

- [ ] Commit.

```bash
git add src/extension.ts src/vscode/commands.ts src/vscode/code-actions.ts \
  test/ts/code-actions.test.ts test/ts/manifest.test.ts package.json \
  package.nls.json package.nls.ja.json
git commit -m "feat: expose inline SQL commands and Code Action"
```

## Task 19: Verify `.py`, Jupyter, and marimo in VS Code integration tests

**Files:**

- Create: `tools/run_vscode_tests.ts`
- Create: `test/support/integration-scenario.ts`
- Create: `test/support/vscode-harness.ts`
- Create: `test/support/semantic-tokens.ts`
- Create: `test/integration/run.ts`
- Create: `test/integration/compatibility.test.ts`
- Create: `test/integration/extension.test.ts`
- Create: `test/integration/notebooks.test.ts`
- Create: `test/integration/semantic-tokens.test.ts`
- Create: `test/integration/untrusted.test.ts`
- Create: `test/ts/run-vscode-tests.test.ts`
- Create: `test/fixtures/notebooks/jupyter.ipynb`
- Create: `test/fixtures/notebooks/marimo.py`
- Create: `test/fixtures/extensions/marimo-language/package.json`
- Create:
  `test/fixtures/extensions/marimo-language/syntaxes/python.tmLanguage.json`
- Create: `test/fixtures/extensions/semantic-probe/package.json`
- Create: `test/fixtures/extensions/semantic-probe/extension.js`
- Create: `test/fixtures/workspaces/trusted/queries.py`
- Create: `test/fixtures/workspaces/untrusted/queries.py`
- Modify: `package.json`

**Integration matrix contract:**

```ts
export const integrationTargets = [
  { notebookType: undefined, language: "python" },
  { notebookType: undefined, language: "mo-python" },
  { notebookType: "jupyter-notebook", language: "python" },
  { notebookType: "marimo-notebook", language: "python" },
  { notebookType: "marimo-notebook", language: "mo-python" },
] as const;
```

- [ ] Make both on-disk notebook fixtures deterministic. `jupyter.ipynb` is nbformat 4
  with two Python code cells: the first contains only `query = "select 1"` and the
  second contains a sibling sentinel. `marimo.py` is a valid generated marimo program,
  not an arbitrary Python file:

```py
import marimo

__generated_with = "0.13.7"
app = marimo.App()


@app.cell
def _():
    query = "select 1"
    return (query,)


@app.cell
def _():
    sibling = "do not edit"
    return (sibling,)


if __name__ == "__main__":
    app.run()
```

  The official compatibility suite opens that URI explicitly with editor type
  `marimo-notebook`, asserts the resulting `NotebookDocument.notebookType`, focuses an
  actual code cell, and verifies its `python` or `mo-python` language ID before
  formatting.

- [ ] Write integration tests before the runner is complete. In an isolated extension
  host, open standalone `.py` and `mo-python`, synthesize Jupyter and marimo notebooks
  with the approved types/languages, focus a cell editor, and execute all three commands
  plus the Code Action.
- [ ] Build a test-only language fixture extension from the hash-verified official
  marimo grammar snapshot. Install it into the isolated extensions directory so
  `mo-python` exists without adding a conflicting language contribution to the product.
  Open `.ipynb` through the exact downloaded VS Code build's built-in
  `jupyter-notebook` serializer; do not register a duplicate. Register an in-memory
  serializer only for `marimo-notebook` inside the integration harness; never ship it.
  The same test-only fixture manifest contributes the `marimo-notebook` type required
  by `registerNotebookSerializer`; the production manifest must not contribute a
  notebook type.

```json
{
  "name": "marimo-language",
  "publisher": "inline-sql-tests",
  "version": "0.0.1",
  "engines": {"vscode": "^1.95.0"},
  "contributes": {
    "languages": [
      {"id": "mo-python", "aliases": ["Marimo Python"]}
    ],
    "grammars": [
      {
        "language": "mo-python",
        "scopeName": "source.mo-python",
        "path": "./syntaxes/python.tmLanguage.json"
      }
    ],
    "notebooks": [
      {
        "type": "marimo-notebook",
        "displayName": "Marimo Test Notebook",
        "selector": [{"filenamePattern": "*.marimo-test"}]
      }
    ]
  }
}
```

  Add a manifest test proving this notebook contribution exists only in the fixture,
  and a stable Extension Host test proving its serializer can register, round-trip,
  and open one `marimo-notebook`.

- [ ] Implement Jupyter open/focus first. Open the copied `.ipynb` URI with
  `workspace.openNotebookDocument(uri)`, assert `notebookType ===
  "jupyter-notebook"`, show it, select one cell, execute `notebook.cell.edit`, and wait
  on `window.onDidChangeActiveTextEditor` until that exact cell document owns focus.
  Use an event-driven timeout only as a failure bound; do not poll or sleep.

```ts
export async function openJupyterCell(
  uri: vscode.Uri,
  cellIndex: number,
): Promise<OpenedCell> {
  const notebook = await vscode.workspace.openNotebookDocument(uri);
  assert.equal(notebook.notebookType, "jupyter-notebook");
  const editor = await vscode.window.showNotebookDocument(notebook);
  const cell = notebook.cellAt(cellIndex);
  editor.selection = new vscode.NotebookRange(cellIndex, cellIndex + 1);
  await vscode.commands.executeCommand("notebook.cell.edit");
  const textEditor = await waitForActiveTextEditor(cell.document.uri, 5_000);
  return { notebook, notebookEditor: editor, cell, textEditor };
}
```

- [ ] Implement the focus waiter race-free. Check the current editor, subscribe,
  check again to close the check/subscribe gap, and own one timeout. Every resolve or
  reject path clears the timer and disposes the event subscription. Unit-test
  already-focused, event-after-subscribe, event-in-the-gap, wrong-editor events, and
  timeout. Apply the same check/subscribe/recheck discipline to the official
  compatibility helper `waitForNotebookDocument()`, with already-open, event-gap,
  wrong-URI, cleanup, and timeout tests.

```ts
export interface OpenedCell {
  readonly notebook: vscode.NotebookDocument;
  readonly notebookEditor: vscode.NotebookEditor;
  readonly cell: vscode.NotebookCell;
  readonly textEditor: vscode.TextEditor;
}

export function waitForActiveTextEditor(
  uri: vscode.Uri,
  timeoutMs: number,
): Promise<vscode.TextEditor> {
  const matches = (editor: vscode.TextEditor | undefined): editor is vscode.TextEditor =>
    editor?.document.uri.toString() === uri.toString();
  const initial = vscode.window.activeTextEditor;
  if (matches(initial)) {
    return Promise.resolve(initial);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let subscription: vscode.Disposable = { dispose() {} };
    const finish = (editor?: vscode.TextEditor): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      subscription.dispose();
      if (editor === undefined) reject(new Error("cell editor focus timed out"));
      else resolve(editor);
    };
    subscription = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (matches(editor)) finish(editor);
    });
    if (settled) {
      subscription.dispose();
      return;
    }
    const current = vscode.window.activeTextEditor;
    if (matches(current)) {
      finish(current);
      return;
    }
    timer = setTimeout(() => finish(), timeoutMs);
  });
}

export function waitForNotebookDocument(
  uri: vscode.Uri,
  timeoutMs: number,
): Promise<vscode.NotebookDocument> {
  const matches = (
    document: vscode.NotebookDocument,
  ): boolean => document.uri.toString() === uri.toString();
  const initial = vscode.workspace.notebookDocuments.find(matches);
  if (initial !== undefined) return Promise.resolve(initial);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let subscription: vscode.Disposable = { dispose() {} };
    const finish = (document?: vscode.NotebookDocument): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      subscription.dispose();
      if (document === undefined) {
        reject(new Error("notebook open timed out"));
      } else {
        resolve(document);
      }
    };
    subscription = vscode.workspace.onDidOpenNotebookDocument((document) => {
      if (matches(document)) finish(document);
    });
    if (settled) {
      subscription.dispose();
      return;
    }
    const current = vscode.workspace.notebookDocuments.find(matches);
    if (current !== undefined) {
      finish(current);
      return;
    }
    timer = setTimeout(() => finish(), timeoutMs);
  });
}

export async function focusNotebookCell(
  notebook: vscode.NotebookDocument,
  cellIndex: number,
): Promise<OpenedCell> {
  const notebookEditor = await vscode.window.showNotebookDocument(notebook);
  const cell = notebook.cellAt(cellIndex);
  notebookEditor.selection = new vscode.NotebookRange(
    cellIndex,
    cellIndex + 1,
  );
  await vscode.commands.executeCommand("notebook.cell.edit");
  const textEditor = await waitForActiveTextEditor(cell.document.uri, 5_000);
  return { notebook, notebookEditor, cell, textEditor };
}
```

- [ ] Implement only the marimo serializer and register it in `run()` cleanup scope.
  Serialize/deserialize a minimal UTF-8 JSON shape containing cell kind, language, and
  text. Open marimo test notebooks from `NotebookData`, assert the requested
  `python`/`mo-python` language ID, focus through the same event-driven cell helper,
  and dispose the serializer in `finally`.

```ts
export function registerMarimoTestSerializer(): vscode.Disposable {
  return vscode.workspace.registerNotebookSerializer(
    "marimo-notebook",
    {
      deserializeNotebook(data) {
        return decodeTestNotebook(data);
      },
      serializeNotebook(data) {
        return encodeTestNotebook(data);
      },
    },
    { transientOutputs: true },
  );
}

interface TestNotebookCellWire {
  readonly kind: "code" | "markup";
  readonly language: string;
  readonly text: string;
}

interface TestNotebookWire {
  readonly cells: readonly TestNotebookCellWire[];
}

function decodeTestNotebook(data: Uint8Array): vscode.NotebookData {
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(data),
  );
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).join("\0") !== "cells"
  ) {
    throw new Error("invalid test notebook");
  }
  const cells = (value as { readonly cells?: unknown }).cells;
  if (!Array.isArray(cells)) throw new Error("invalid test notebook cells");
  return new vscode.NotebookData(
    cells.map((item): vscode.NotebookCellData => {
      if (
        typeof item !== "object" ||
        item === null ||
        Array.isArray(item) ||
        Object.keys(item).sort().join("\0") !== "kind\0language\0text"
      ) {
        throw new Error("invalid test notebook cell");
      }
      const cell = item as Record<string, unknown>;
      if (
        (cell.kind !== "code" && cell.kind !== "markup") ||
        typeof cell.language !== "string" ||
        typeof cell.text !== "string"
      ) {
        throw new Error("invalid test notebook cell value");
      }
      return new vscode.NotebookCellData(
        cell.kind === "code"
          ? vscode.NotebookCellKind.Code
          : vscode.NotebookCellKind.Markup,
        cell.text,
        cell.language,
      );
    }),
  );
}

function encodeTestNotebook(data: vscode.NotebookData): Uint8Array {
  const wire: TestNotebookWire = {
    cells: data.cells.map((cell) => ({
      kind:
        cell.kind === vscode.NotebookCellKind.Code ? "code" : "markup",
      language: cell.languageId,
      text: cell.value,
    })),
  };
  return new TextEncoder().encode(JSON.stringify(wire));
}

export async function openMarimoCell(
  languageId: "python" | "mo-python",
  source: string,
): Promise<OpenedCell> {
  const data = new vscode.NotebookData([
    new vscode.NotebookCellData(
      vscode.NotebookCellKind.Code,
      source,
      languageId,
    ),
  ]);
  const notebook = await vscode.workspace.openNotebookDocument(
    "marimo-notebook",
    data,
  );
  return focusNotebookCell(notebook, 0);
}
```
- [ ] Assert TextMate token scopes on SQL and Python field segments, exact formatted
  text, fields unchanged, current-cell-only behavior for all mode, selection expansion,
  cursor targeting, partial success, one-operation undo, and no edit in sibling cells.
  Before starting each Extension Host, make `run_vscode_tests.ts` load the built-in
  Python grammar from that exact downloaded VS Code installation plus the product and
  test-extension grammar contributions through `vscode-textmate`; run the TextMate
  scope assertions there. Inside the Extension Host, test formatting behavior and
  invoke the document semantic-token provider, failing if it assigns an overriding
  token across a verified SQL segment. Do not attempt to read TextMate scopes through
  the public Extension API, which does not expose them.

- [ ] Reuse Task 1's grammar registry before each host launch. Resolve built-in Python
  and SQL contributions from the exact downloaded installation manifest, merge the
  product's two grammar contributions and pinned marimo contribution, and run the
  shared PEP 701/detection cases for both base scopes. Fail before spawn on a missing
  contribution, duplicate scope, embedded-language mismatch, or scope mismatch.

```ts
export async function verifyIntegrationGrammarScopes(
  version: "1.95.0" | "stable",
  officialMarimoExtensionRoot?: string,
): Promise<void> {
  const options: GrammarLoadOptions =
    officialMarimoExtensionRoot === undefined
      ? {}
      : { marimoExtensionRoot: officialMarimoExtensionRoot };
  for (const testCase of loadGrammarCases("pep701-grammar-cases.json")) {
    await verifyPep701GrammarCase(version, testCase, options);
  }
  await runDetectionParityForVersion(version, options);
}
```

  `verifyPep701GrammarCase` comes from Task 1's VS Code-independent
  `test/support/grammar-loader.ts`; `runDetectionParityForVersion` comes from Task 2's
  equally pure `test/support/detection-parity.ts`. The former retains
  `tokenizeWithEmbeddedLanguages` as the single loader: it reads built-in manifests,
  production `package.json`, and either the pinned marimo manifest (normal matrix) or
  the freshly installed official extension manifest (compatibility matrix). Task 19
  imports those support modules instead of loading Vitest files or reimplementing
  grammar discovery.

- [ ] Install a deterministic test-only semantic-token provider fixture in the normal
  matrix. Its safe mode emits a token on Python outside the SQL span; its overlap mode
  deliberately emits one across the SQL span. First prove the overlap checker rejects
  overlap mode, switch to safe mode, then run the product assertion. A missing/empty
  provider result is a test failure, so this regression check cannot pass vacuously.
  In weekly compatibility tests, omit this fixture and require the same check against
  the installed official Python extension's actual provider when one is registered.

- [ ] Implement semantic-token delta decoding as a pure helper. Require a non-empty
  five-integer stream, accumulate line/start deltas exactly, reject overflow and
  out-of-document positions with Task 17's strict position guard, and represent every
  token as a half-open `vscode.Range`. Strict overlap is
  `token.start < sql.end && sql.start < token.end`; boundary contact is allowed.

```ts
export function decodeSemanticTokens(
  document: vscode.TextDocument,
  tokens: vscode.SemanticTokens,
): readonly vscode.Range[] {
  if (tokens.data.length === 0 || tokens.data.length % 5 !== 0) {
    throw new Error("semantic provider returned no complete token");
  }
  const ranges: vscode.Range[] = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < tokens.data.length; index += 5) {
    const deltaLine = tokens.data[index]!;
    const deltaStart = tokens.data[index + 1]!;
    const length = tokens.data[index + 2]!;
    line += deltaLine;
    character = deltaLine === 0 ? character + deltaStart : deltaStart;
    const start = strictPosition(document, { line, character });
    const end = strictPosition(document, {
      line,
      character: character + length,
    });
    if (start === undefined || end === undefined || start.isAfterOrEqual(end)) {
      throw new Error("semantic provider returned an invalid token");
    }
    ranges.push(new vscode.Range(start, end));
  }
  return ranges;
}

export function assertNoSemanticSqlOverlap(
  semanticRanges: readonly vscode.Range[],
  sqlRanges: readonly vscode.Range[],
): void {
  for (const semantic of semanticRanges) {
    for (const sql of sqlRanges) {
      if (semantic.start.isBefore(sql.end) && sql.start.isBefore(semantic.end)) {
        throw new Error("semantic token overrides inline SQL");
      }
    }
  }
}
```

- [ ] Implement `semantic-probe/extension.js` with one provider and one unmanifested
  test command `inlineSql.semanticProbe.setMode`. Safe mode marks `query` outside the
  literal; overlap mode marks the physical `SELECT` segment. The integration test
  requests tokens through `vscode.provideDocumentSemanticTokens`, proves overlap mode
  is rejected, switches to safe, requires a non-empty result, and then runs the normal
  no-overlap assertion.

```js
const vscode = require("vscode");

function activate(context) {
  let mode = "safe";
  const legend = new vscode.SemanticTokensLegend(["variable", "string"], []);
  const provider = {
    provideDocumentSemanticTokens(document) {
      const text = document.getText();
      const needle = mode === "overlap" ? "SELECT" : "query";
      const offset = text.indexOf(needle);
      const builder = new vscode.SemanticTokensBuilder(legend);
      if (offset >= 0) {
        builder.push(
          new vscode.Range(
            document.positionAt(offset),
            document.positionAt(offset + needle.length),
          ),
          mode === "overlap" ? "string" : "variable",
          [],
        );
      }
      return builder.build();
    },
  };
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      [{ language: "python" }, { language: "mo-python" }],
      provider,
      legend,
    ),
    vscode.commands.registerCommand(
      "inlineSql.semanticProbe.setMode",
      (value) => {
        if (value !== "safe" && value !== "overlap") {
          throw new Error("invalid semantic probe mode");
        }
        mode = value;
      },
    ),
  );
}

module.exports = { activate };
```

```json
{
  "name": "inline-sql-semantic-probe",
  "publisher": "inline-sql-tests",
  "version": "0.0.1",
  "engines": {"vscode": "^1.95.0"},
  "main": "./extension.js",
  "activationEvents": ["onLanguage:python", "onLanguage:mo-python"]
}
```
- [ ] Add a race test that changes text after helper response and before application;
  assert `DOCUMENT_CHANGED` and zero edits. Add an apply-false test. Query formatting
  providers in the isolated host and assert this extension contributes none.
- [ ] Drive races only through Task 17's test-mode hooks: configure
  `pauseBeforeApply`, wait until `readHooks` reports the barrier reached, mutate/cancel/
  revoke trust, then release it. Drive apply failure with `forcedApplyResult=false`.
  Read in-memory spawn counts for the untrusted zero-process assertion; do not use
  timing sleeps, filesystem sentinels, or platform-specific fake executables.
- [ ] Run trusted and untrusted scenarios in separate extension hosts and separate
  user-data directories. The untrusted fixture must assert
  `workspace.isTrusted === false`, grammar highlighting remains, Code Action is absent,
  commands apply no edits, and a process sentinel records zero spawns.
- [ ] Add runner argument tests before launch code. Use
  `@vscode/test-electron` only to download/resolve the requested build; do not use its
  `runTests()` helper because that helper adds `--disable-workspace-trust`. Spawn the
  resolved VS Code executable directly with argument arrays. The trusted scenario
  explicitly includes `--disable-workspace-trust`; the untrusted scenario omits it and
  uses a fresh user-data directory and workspace. Neither path uses `shell: true`.

```ts
const launchArgs = [
  workspacePath,
  `--extensionDevelopmentPath=${repositoryRoot}`,
  `--extensionTestsPath=${testsPath}`,
  "--user-data-dir",
  userDataDir,
  "--extensions-dir",
  extensionsDir,
  "--disable-updates",
  "--skip-welcome",
  "--skip-release-notes",
];
if (scenario !== "untrusted") {
  launchArgs.push("--disable-workspace-trust");
}
const command = process.platform === "linux" ? "xvfb-run" : executable;
const args =
  process.platform === "linux"
    ? ["-a", executable, ...launchArgs]
    : launchArgs;
```
- [ ] Run the new tests before implementing the runner and confirm harness/activation
  failures.

```bash
INLINE_SQL_TEST_PYTHON="$(uv python find 3.12)" \
  VSCODE_TEST_VERSION=1.95.0 bun run test:integration:trusted
INLINE_SQL_TEST_PYTHON="$(uv python find 3.12)" \
  VSCODE_TEST_VERSION=1.95.0 bun run test:integration:untrusted
```

- [ ] Implement `run_vscode_tests.ts` with isolated extension, user-data, and workspace
  directories. On Linux invoke Electron through `xvfb-run -a`; on macOS and Windows use
  the downloaded executable directly. Bundle the custom integration runner to
  `dist-test/integration/run.js` as CommonJS with only `vscode` external; do not depend
  on an undeclared Mocha runtime. Never reuse a trusted profile for the untrusted run.

```ts
// test/support/integration-scenario.ts — intentionally has no `vscode` import.
export type IntegrationScenario =
  | "trusted"
  | "untrusted"
  | "compatibility";

export function parseScenario(value: string | undefined): IntegrationScenario {
  if (
    value === "trusted" ||
    value === "untrusted" ||
    value === "compatibility"
  ) {
    return value;
  }
  throw new Error("invalid integration scenario");
}

// tools/run_vscode_tests.ts
interface ScenarioOptions {
  readonly scenario: IntegrationScenario;
  readonly vscodeVersion: "1.95.0" | "stable";
  readonly pythonPath: string;
  readonly repositoryRoot: string;
}

export async function launchScenario(options: ScenarioOptions): Promise<void> {
  const scenarioRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), `inline-sql-${options.scenario}-`),
  );
  try {
    const userDataDir = path.join(scenarioRoot, "user-data");
    const extensionsDir = path.join(scenarioRoot, "extensions");
    const workspacePath = path.join(scenarioRoot, "workspace");
    await Promise.all([
      fs.mkdir(userDataDir),
      fs.mkdir(extensionsDir),
      copyScenarioWorkspace(
        options.scenario,
        workspacePath,
        options.repositoryRoot,
      ),
    ]);
    await writeScenarioUserSettings(options.scenario, userDataDir);
    const executable = await downloadAndUnzipVSCode(options.vscodeVersion);
    const officialMarimoExtensionRoot = await installFixtureExtensions(
      options.scenario,
      extensionsDir,
      executable,
      options.repositoryRoot,
    );
    await verifyIntegrationGrammarScopes(
      options.vscodeVersion,
      officialMarimoExtensionRoot,
    );
    const testsPath = path.join(
      options.repositoryRoot,
      "dist-test",
      "integration",
      "run.js",
    );
    const { command, args } = buildLaunchCommand({
      executable,
      repositoryRoot: options.repositoryRoot,
      testsPath,
      workspacePath,
      userDataDir,
      extensionsDir,
      scenario: options.scenario,
    });
    await spawnAndRequireZero(
      command,
      args,
      {
        env: {
          ...process.env,
          INLINE_SQL_TEST_SCENARIO: options.scenario,
          INLINE_SQL_TEST_PYTHON: options.pythonPath,
        },
        shell: false,
        stdio: "inherit",
        timeoutMs: 5 * 60_000,
      },
    );
  } finally {
    await fs.rm(scenarioRoot, { recursive: true, force: true });
  }
}
```

- [ ] Make the runner executable, not just importable. Before launching a host, build
  the production extension and bundle `test/integration/run.ts` to the exact
  `dist-test/integration/run.js` path consumed above. The integration bundle is
  CommonJS, targets Node 20, and has only `vscode` external. Parse the fixed scenario
  and version enums. Accept an absolute existing `INLINE_SQL_TEST_PYTHON` override;
  otherwise resolve exactly Python 3.12 through pinned `uv python find 3.12` with a
  bounded shell-free subprocess. Derive the repository root from `import.meta.url` and
  await one scenario. Unknown scenario/version or unresolved Python fails non-zero
  before download.

```ts
async function buildIntegrationRunner(repositoryRoot: string): Promise<void> {
  await build({
    entryPoints: [
      path.join(repositoryRoot, "test", "integration", "run.ts"),
    ],
    outfile: path.join(
      repositoryRoot,
      "dist-test",
      "integration",
      "run.js",
    ),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    sourcemap: false,
    legalComments: "none",
  });
}

function parseGrammarVersion(
  value: string | undefined,
): "1.95.0" | "stable" {
  if (value === undefined) return "1.95.0";
  if (value === "1.95.0" || value === "stable") return value;
  throw new Error("invalid VSCODE_TEST_VERSION");
}

async function resolveIntegrationPython(
  override: string | undefined,
): Promise<string> {
  let candidate = override;
  if (candidate === undefined) {
    const { stdout } = await execFileAsync(
      "uv",
      ["python", "find", "3.12"],
      {
        encoding: "utf8",
        maxBuffer: 4_096,
        timeout: 10_000,
        windowsHide: true,
      },
    );
    candidate = stdout.trim();
  }
  if (
    !path.isAbsolute(candidate) ||
    candidate.includes("\0") ||
    candidate.includes("\r") ||
    candidate.includes("\n")
  ) {
    throw new Error("integration Python path must be one absolute line");
  }
  await fs.access(candidate, fsConstants.X_OK);
  return candidate;
}

export async function main(argv: readonly string[]): Promise<void> {
  const scenario = parseScenario(argv[2]);
  const vscodeVersion = parseGrammarVersion(
    process.env.VSCODE_TEST_VERSION,
  );
  const pythonPath = await resolveIntegrationPython(
    process.env.INLINE_SQL_TEST_PYTHON,
  );
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  await buildExtension();
  await buildIntegrationRunner(repositoryRoot);
  await launchScenario({
    scenario,
    vscodeVersion,
    pythonPath,
    repositoryRoot,
  });
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main(process.argv);
}
```

  Import `build` from `esbuild`, `buildExtension` from `tools/build.ts`,
  `execFile`/`promisify` for `execFileAsync`, `constants as fsConstants` plus promise
  APIs from `node:fs`, URL/path helpers, and `parseScenario` from the VS Code-independent
  support module. Unit tests invoke
  `main()` with injected builder/downloader/launcher dependencies so they prove one
  build and one launch, and prove no launch on bad argv/version/Python path. Resolver
  tests cover override, uv fallback, timeout, oversized/multiline output, relative
  output, missing executable, and Windows-style absolute paths.

- [ ] Implement the runner helpers rather than leaving path policy implicit.
  `copyScenarioWorkspace` maps only the three scenario enum values to fixed fixtures.
  Normal scenarios copy the marimo-language and semantic-probe directories under
  unique extension IDs; compatibility installs the three fixed Marketplace IDs through
  the downloaded build's CLI with argument arrays. `buildLaunchCommand` is the sole
  owner of Linux `xvfb-run` and trust flags.

```ts
const fixtureExtensions = [
  ["marimo-language", "inline-sql-tests.marimo-language-0.0.1"],
  ["semantic-probe", "inline-sql-tests.inline-sql-semantic-probe-0.0.1"],
] as const;

async function writeScenarioUserSettings(
  scenario: ScenarioOptions["scenario"],
  userDataDir: string,
): Promise<void> {
  const userDir = path.join(userDataDir, "User");
  await fs.mkdir(userDir);
  const settings =
    scenario === "untrusted"
      ? {
          "security.workspace.trust.enabled": true,
          "security.workspace.trust.startupPrompt": "never",
        }
      : {};
  await fs.writeFile(
    path.join(userDir, "settings.json"),
    JSON.stringify(settings),
    { encoding: "utf8", flag: "wx" },
  );
}

async function copyScenarioWorkspace(
  scenario: ScenarioOptions["scenario"],
  destination: string,
  repositoryRoot: string,
): Promise<void> {
  const fixture = scenario === "untrusted" ? "untrusted" : "trusted";
  await fs.cp(
    path.join(repositoryRoot, "test", "fixtures", "workspaces", fixture),
    destination,
    { recursive: true, errorOnExist: true },
  );
  await fs.copyFile(
    path.join(
      repositoryRoot,
      "test",
      "fixtures",
      "notebooks",
      "jupyter.ipynb",
    ),
    path.join(destination, "jupyter.ipynb"),
  );
  await fs.copyFile(
    path.join(
      repositoryRoot,
      "test",
      "fixtures",
      "notebooks",
      "marimo.py",
    ),
    path.join(destination, "marimo.py"),
  );
}

async function installFixtureExtensions(
  scenario: ScenarioOptions["scenario"],
  extensionsDir: string,
  executable: string,
  repositoryRoot: string,
): Promise<string | undefined> {
  if (scenario === "compatibility") {
    await installCompatibilityExtensions(
      executable,
      extensionsDir,
      ["ms-python.python", "ms-toolsai.jupyter", "marimo-team.vscode-marimo"],
    );
    return findInstalledExtensionRoot(
      extensionsDir,
      "marimo-team.vscode-marimo",
    );
  }
  for (const [sourceName, installedName] of fixtureExtensions) {
    await fs.cp(
      path.join(repositoryRoot, "test", "fixtures", "extensions", sourceName),
      path.join(extensionsDir, installedName),
      { recursive: true, errorOnExist: true },
    );
  }
  return undefined;
}

async function findInstalledExtensionRoot(
  extensionsDir: string,
  extensionId: string,
): Promise<string> {
  const prefix = `${extensionId}-`;
  const matches = (await fs.readdir(extensionsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(extensionsDir, entry.name));
  if (matches.length !== 1) {
    throw new Error(`expected one installed ${extensionId}`);
  }
  const root = path.resolve(matches[0]!);
  if (
    path.dirname(root) !== path.resolve(extensionsDir) ||
    !root.startsWith(`${path.resolve(extensionsDir)}${path.sep}`)
  ) {
    throw new Error("installed extension escaped extensions directory");
  }
  return root;
}

async function installCompatibilityExtensions(
  executable: string,
  extensionsDir: string,
  extensionIds: readonly string[],
): Promise<void> {
  const appRoot =
    process.platform === "darwin"
      ? path.resolve(executable, "../../Resources/app")
      : path.resolve(path.dirname(executable), "resources/app");
  const cliScript = path.join(appRoot, "out", "cli.js");
  for (const extensionId of extensionIds) {
    await spawnAndRequireZero(
      executable,
      [
        cliScript,
        "--extensions-dir",
        extensionsDir,
        "--install-extension",
        extensionId,
        "--force",
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        shell: false,
        timeoutMs: 120_000,
      },
    );
  }
}

interface LaunchInput {
  readonly executable: string;
  readonly repositoryRoot: string;
  readonly testsPath: string;
  readonly workspacePath: string;
  readonly userDataDir: string;
  readonly extensionsDir: string;
  readonly scenario: IntegrationScenario;
}

interface LaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
}

function buildLaunchCommand(input: LaunchInput): LaunchCommand {
  const launchArgs = [
    input.workspacePath,
    `--extensionDevelopmentPath=${input.repositoryRoot}`,
    `--extensionTestsPath=${input.testsPath}`,
    "--user-data-dir",
    input.userDataDir,
    "--extensions-dir",
    input.extensionsDir,
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
  ];
  if (input.scenario !== "untrusted") {
    launchArgs.push("--disable-workspace-trust");
  }
  return process.platform === "linux"
    ? { command: "xvfb-run", args: ["-a", input.executable, ...launchArgs] }
    : { command: input.executable, args: launchArgs };
}

interface SpawnRunOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio?: "inherit";
  readonly timeoutMs: number;
}

async function spawnAndRequireZero(
  command: string,
  args: readonly string[],
  options: SpawnRunOptions,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        detached: process.platform !== "win32",
        env: options.env,
        shell: false,
        stdio: options.stdio ?? "inherit",
        windowsHide: true,
      });
    } catch {
      reject(new Error("VS Code process spawn failed"));
      return;
    }
    let settled = false;
    let timingOut = false;
    let timer: NodeJS.Timeout | undefined;
    const deadline = Date.now() + options.timeoutMs;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      child.removeAllListeners();
      if (error === undefined) resolve();
      else reject(error);
    };
    const beginTimeout = (): void => {
      if (settled || timingOut) return;
      timingOut = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      child.removeAllListeners();
      const timeoutError = new Error("VS Code process timed out");
      if (child.pid === undefined) {
        finish(timeoutError);
        return;
      }
      void terminateProcessTree(child.pid).then(
        () => finish(timeoutError),
        () => finish(timeoutError),
      );
    };
    child.once("error", () => {
      if (Date.now() >= deadline) beginTimeout();
      else finish(new Error("VS Code process failed"));
    });
    child.once("exit", (code, signal) => {
      if (Date.now() >= deadline) beginTimeout();
      else if (code === 0 && signal === null) finish();
      else finish(new Error("VS Code process exited unsuccessfully"));
    });
    if (settled) {
      child.removeAllListeners();
      return;
    }
    timer = setTimeout(beginTimeout, options.timeoutMs);
  });
}

async function terminateProcessTree(processId: number): Promise<void> {
  if (process.platform !== "win32") {
    try {
      process.kill(-processId, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn(
      "taskkill.exe",
      ["/pid", String(processId), "/T", "/F"],
      { shell: false, stdio: "ignore", windowsHide: true },
    );
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      killer.removeAllListeners();
      resolve();
    };
    killer.once("error", finish);
    killer.once("exit", finish);
    if (settled) {
      killer.removeAllListeners();
      return;
    }
    timer = setTimeout(() => {
      killer.kill();
      finish();
    }, 10_000);
  });
}
```

  `repositoryRoot` in the implementation is passed explicitly to both helper
  functions rather than read as ambient state. Unit tests reject unknown scenario
  strings and assert every copied/installed target remains below its fresh scenario
  root. Fake-clock tests cover timeout, kill-tree call, synchronous spawn throw,
  error/exit races, listener/timer cleanup, and single settlement. `scenarioRoot` is
  always the exact return value from `mkdtemp`; validate its basename prefix before
  recursive cleanup.

- [ ] Implement the CommonJS integration entrypoint without Mocha. Export one
  `run(): Promise<void>`, select scenario test functions from the fixed environment
  enum, run them sequentially for deterministic editor focus, and throw
  `AggregateError` after cleanup if any assertion failed.

  `IntegrationScenario` and `parseScenario()` live in the VS Code-independent
  `test/support/integration-scenario.ts`; both the Node runner and Extension Host
  entrypoint import that one definition. `vscode-harness.ts` imports it only as needed
  and is never loaded by the outer Node runner. The entrypoint imports every suite
  function directly so no identifier is supplied through globals or dynamic test
  discovery.

```ts
import { testApplyRaces, testStandaloneFormatting } from "./extension.test";
import { testOfficialExtensionCompatibility } from "./compatibility.test";
import { testNotebookFormatting } from "./notebooks.test";
import { testSemanticTokenIsolation } from "./semantic-tokens.test";
import { testUntrustedHighlightOnly } from "./untrusted.test";
import {
  type IntegrationScenario,
  parseScenario,
} from "../support/integration-scenario";
import { registerMarimoTestSerializer } from "../support/vscode-harness";

export async function run(): Promise<void> {
  const scenario = parseScenario(process.env.INLINE_SQL_TEST_SCENARIO);
  const tests = scenarioTests(scenario);
  const failures: unknown[] = [];
  const marimoSerializer =
    scenario === "compatibility" ? undefined : registerMarimoTestSerializer();
  try {
    for (const test of tests) {
      try {
        await test();
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    marimoSerializer?.dispose();
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Inline SQL integration tests failed");
  }
}
```

- [ ] Implement the imported suite functions as real sequential assertions, not empty
  exports. Use one exact fixture contract so the assertions are deterministic:
  standalone and every code cell start with `query = "select 1"` and end with
  `query = "SELECT 1"`; the multi-candidate fixture additionally contains one safe
  f-string and one intentionally unsupported concatenation. The shared harness sets
  `inlineSql.pythonPath` from `INLINE_SQL_TEST_PYTHON`; its unit test rejects a
  missing/relative Python path before any suite starts.

```ts
const LOWER = 'query = "select 1"';
const UPPER = 'query = "SELECT 1"';

function workspaceRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) throw new Error("missing test workspace");
  return folder.uri;
}

function preserveFinalNewline(document: vscode.TextDocument, text: string): string {
  return document.getText().endsWith("\n") ? `${text}\n` : text;
}

async function replaceWholeDocument(
  document: vscode.TextDocument,
  text: string,
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(
      new vscode.Position(0, 0),
      document.positionAt(document.getText().length),
    ),
    text,
  );
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

async function configureIntegrationPython(
  document: vscode.TextDocument,
): Promise<void> {
  const pythonPath = process.env.INLINE_SQL_TEST_PYTHON;
  if (pythonPath === undefined || !path.isAbsolute(pythonPath)) {
    throw new Error("integration Python path must be absolute");
  }
  await vscode.workspace
    .getConfiguration("inlineSql", document.uri)
    .update(
      "pythonPath",
      pythonPath,
      vscode.ConfigurationTarget.Workspace,
    );
}

async function openStandaloneFixture(
  language: "python" | "mo-python",
): Promise<vscode.TextDocument> {
  let document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(workspaceRoot(), "queries.py"),
  );
  document = await vscode.languages.setTextDocumentLanguage(document, language);
  await replaceWholeDocument(document, preserveFinalNewline(document, LOWER));
  return document;
}

function selectNeedle(
  document: vscode.TextDocument,
  editor: vscode.TextEditor,
  nonEmpty: boolean,
): void {
  const startOffset = document.getText().indexOf("select");
  assert.notEqual(startOffset, -1);
  const start = document.positionAt(startOffset);
  const end = document.positionAt(startOffset + (nonEmpty ? "select".length : 0));
  editor.selection = new vscode.Selection(start, end);
}

async function assertSingleCommandAndUndo(
  document: vscode.TextDocument,
  editor: vscode.TextEditor,
  command: "inlineSql.formatAtCursor" | "inlineSql.formatSelection",
): Promise<void> {
  const before = preserveFinalNewline(document, LOWER);
  await replaceWholeDocument(document, before);
  selectNeedle(document, editor, command === "inlineSql.formatSelection");
  await vscode.commands.executeCommand(command);
  assert.equal(document.getText(), preserveFinalNewline(document, UPPER));
  await vscode.commands.executeCommand("undo");
  assert.equal(document.getText(), before);
}

async function assertAllCommandAndSingleUndo(
  document: vscode.TextDocument,
  editor: vscode.TextEditor,
): Promise<void> {
  const newline = document.getText().endsWith("\n") ? "\n" : "";
  const before = `first = "select 1"\nsecond = "select 2"${newline}`;
  const after = `first = "SELECT 1"\nsecond = "SELECT 2"${newline}`;
  await replaceWholeDocument(document, before);
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.commands.executeCommand("inlineSql.formatAll");
  assert.equal(document.getText(), after);
  await vscode.commands.executeCommand("undo");
  assert.equal(document.getText(), before);
}

async function assertFstringAndPartialSuccess(
  document: vscode.TextDocument,
  editor: vscode.TextEditor,
): Promise<void> {
  const newline = document.getText().endsWith("\n") ? "\n" : "";
  const field = "{value!r}";
  const before =
    `safe = f"select ${field}"\n` +
    `unsupported = "select " "2"${newline}`;
  const after =
    `safe = f"SELECT ${field}"\n` +
    `unsupported = "select " "2"${newline}`;
  await replaceWholeDocument(document, before);
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.commands.executeCommand("inlineSql.test.configureHooks", {});
  await vscode.commands.executeCommand("inlineSql.formatAll");
  assert.equal(document.getText(), after);
  assert.equal(document.getText().includes(field), true);
  const hooks = await vscode.commands.executeCommand<HookSnapshot>(
    "inlineSql.test.readHooks",
  );
  assert.deepEqual(hooks.lastOutcome, { changed: 1, skipped: 1 });
  await vscode.commands.executeCommand("undo");
  assert.equal(document.getText(), before);
}

async function assertFormattingCodeAction(
  document: vscode.TextDocument,
  editor: vscode.TextEditor,
): Promise<void> {
  await replaceWholeDocument(
    document,
    preserveFinalNewline(document, LOWER),
  );
  selectNeedle(document, editor, false);
  const actions = await vscode.commands.executeCommand<
    readonly vscode.CodeAction[]
  >(
    "vscode.executeCodeActionProvider",
    document.uri,
    editor.selection,
    vscode.CodeActionKind.RefactorRewrite.value,
  );
  const action = actions?.find(
    (candidate) => candidate.title === "Format inline SQL",
  );
  if (action?.command === undefined) {
    throw new Error("missing inline SQL Code Action");
  }
  await vscode.commands.executeCommand(
    action.command.command,
    ...(action.command.arguments ?? []),
  );
  assert.equal(document.getText(), preserveFinalNewline(document, UPPER));
}

async function assertNoDocumentFormattingProvider(
  document: vscode.TextDocument,
): Promise<void> {
  const edits = await vscode.commands.executeCommand<
    readonly vscode.TextEdit[] | undefined
  >(
    "vscode.executeFormatDocumentProvider",
    document.uri,
    { tabSize: 2, insertSpaces: true },
  );
  assert.equal(edits?.length ?? 0, 0);
}

export async function testStandaloneFormatting(): Promise<void> {
  for (const language of ["python", "mo-python"] as const) {
    const document = await openStandaloneFixture(language);
    const editor = await vscode.window.showTextDocument(document);
    await configureIntegrationPython(document);
    await assertSingleCommandAndUndo(
      document,
      editor,
      "inlineSql.formatAtCursor",
    );
    await assertSingleCommandAndUndo(
      document,
      editor,
      "inlineSql.formatSelection",
    );
    await assertAllCommandAndSingleUndo(document, editor);
    await assertFstringAndPartialSuccess(document, editor);
    await assertFormattingCodeAction(document, editor);
    await assertNoDocumentFormattingProvider(document);
  }
}

async function assertThreeCommandsAndCodeAction(
  opened: OpenedCell,
): Promise<void> {
  const siblingTexts = opened.notebook
    .getCells()
    .filter((cell) => cell.index !== opened.cell.index)
    .map(
      (cell) =>
        [
          cell.document.uri.toString(),
          cell.document.getText(),
          cell.document.version,
        ] as const,
    );
  await configureIntegrationPython(opened.cell.document);
  await assertSingleCommandAndUndo(
    opened.cell.document,
    opened.textEditor,
    "inlineSql.formatAtCursor",
  );
  await assertSingleCommandAndUndo(
    opened.cell.document,
    opened.textEditor,
    "inlineSql.formatSelection",
  );
  await assertAllCommandAndSingleUndo(
    opened.cell.document,
    opened.textEditor,
  );
  await assertFstringAndPartialSuccess(
    opened.cell.document,
    opened.textEditor,
  );
  await assertFormattingCodeAction(opened.cell.document, opened.textEditor);
  for (const [uri, text, version] of siblingTexts) {
    const sibling = opened.notebook
      .getCells()
      .find((cell) => cell.document.uri.toString() === uri);
    assert.equal(sibling?.document.getText(), text);
    assert.equal(sibling?.document.version, version);
  }
}

function jupyterFixtureUri(): vscode.Uri {
  return vscode.Uri.joinPath(workspaceRoot(), "jupyter.ipynb");
}

export async function testNotebookFormatting(): Promise<void> {
  const jupyter = await openJupyterCell(jupyterFixtureUri(), 0);
  await assertThreeCommandsAndCodeAction(jupyter);
  for (const language of ["python", "mo-python"] as const) {
    const marimo = await openMarimoCell(language, 'query = "select 1"');
    await assertThreeCommandsAndCodeAction(marimo);
  }
}
```

  `assertThreeCommandsAndCodeAction()` restores the original cell through one
  `WorkspaceEdit` between cases, then separately exercises cursor, non-empty
  selection, all, and the returned `refactor.rewrite` action. It asserts each command
  is one undo step, the f-string field bytes are unchanged, the unsupported candidate
  is reported while safe edits still apply, and all sibling cell versions/text remain
  unchanged.

- [ ] Implement the remaining exports with the same level of observable checks.
  `testSemanticTokenIsolation()` switches the probe to overlap, proves
  `assertNoSemanticSqlOverlap()` throws, switches to safe, requires a non-empty token
  stream, and proves no overlap. `testApplyRaces()` uses the Task 17 barrier to cover
  document mutation, cancellation, trust revocation, and forced apply-false, checking
  text/version after each. `testUntrustedHighlightOnly()` first requires
  `workspace.isTrusted === false`, then checks no Code Action, no edit, and exact zero
  version/helper spawn counts. `testOfficialExtensionCompatibility()` repeats the
  standalone, Jupyter, marimo, and semantic assertions with only the three official
  extensions installed. Each function owns a 30-second rejection timeout and removes
  listeners/configuration in `finally`; it does not sleep or poll.

```ts
interface HookSnapshot {
  readonly barrierReached: boolean;
  readonly spawnCounts: {
    readonly version: number;
    readonly helper: number;
  };
  readonly lastOutcome: TestOperationOutcome | undefined;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("integration assertion timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function physicalSqlRange(document: vscode.TextDocument): vscode.Range {
  const text = document.getText();
  const offset = text.indexOf("SELECT");
  if (offset < 0) throw new Error("missing physical SQL segment");
  return new vscode.Range(
    document.positionAt(offset),
    document.positionAt(offset + "SELECT".length),
  );
}

async function provideFullSemanticTokens(
  document: vscode.TextDocument,
): Promise<vscode.SemanticTokens> {
  const result = await vscode.commands.executeCommand<
    vscode.SemanticTokens | vscode.SemanticTokensEdits | undefined
  >("vscode.provideDocumentSemanticTokens", document.uri);
  if (result === undefined || !("data" in result) || result.data.length === 0) {
    throw new Error("semantic provider returned no full token stream");
  }
  return result;
}

export async function testSemanticTokenIsolation(): Promise<void> {
  const document = await openStandaloneFixture("python");
  await replaceWholeDocument(
    document,
    preserveFinalNewline(document, UPPER),
  );
  await vscode.window.showTextDocument(document);
  const sqlRanges = [physicalSqlRange(document)];
  await vscode.commands.executeCommand(
    "inlineSql.semanticProbe.setMode",
    "overlap",
  );
  const overlapping = decodeSemanticTokens(
    document,
    await provideFullSemanticTokens(document),
  );
  assert.throws(() => assertNoSemanticSqlOverlap(overlapping, sqlRanges));
  await vscode.commands.executeCommand(
    "inlineSql.semanticProbe.setMode",
    "safe",
  );
  const safe = decodeSemanticTokens(
    document,
    await provideFullSemanticTokens(document),
  );
  assertNoSemanticSqlOverlap(safe, sqlRanges);
}

async function waitForBarrier(): Promise<HookSnapshot> {
  const snapshot = await withTimeout(
    vscode.commands.executeCommand<HookSnapshot>(
      "inlineSql.test.readHooks",
      { waitForBarrier: true },
    ),
  );
  if (!snapshot.barrierReached) throw new Error("apply barrier was not reached");
  return snapshot;
}

async function runPausedRace(
  document: vscode.TextDocument,
  configuration: {
    readonly cancelAtBarrier?: boolean;
    readonly workspaceTrustOverride?: boolean;
  },
  atBarrier: () => Promise<void>,
): Promise<number> {
  await replaceWholeDocument(
    document,
    preserveFinalNewline(document, LOWER),
  );
  await vscode.commands.executeCommand("inlineSql.test.configureHooks", {
    pauseBeforeApply: true,
    ...configuration,
  });
  const barrier = waitForBarrier();
  const operation = vscode.commands.executeCommand("inlineSql.formatAll");
  await barrier;
  await atBarrier();
  const guardedVersion = document.version;
  await vscode.commands.executeCommand("inlineSql.test.releaseBeforeApply");
  await withTimeout(operation);
  return guardedVersion;
}

export async function testApplyRaces(): Promise<void> {
  const document = await openStandaloneFixture("python");
  await vscode.window.showTextDocument(document);
  await configureIntegrationPython(document);
  try {
    const changed = preserveFinalNewline(document, 'query = "changed"');
    const changedVersion = await runPausedRace(document, {}, async () => {
      await replaceWholeDocument(document, changed);
    });
    assert.equal(document.getText(), changed);
    assert.equal(document.version, changedVersion);

    const cancelledVersion = await runPausedRace(
      document,
      { cancelAtBarrier: true },
      async () => {},
    );
    assert.equal(document.getText(), preserveFinalNewline(document, LOWER));
    assert.equal(document.version, cancelledVersion);

    const untrustedVersion = await runPausedRace(
      document,
      { workspaceTrustOverride: false },
      async () => {},
    );
    assert.equal(document.getText(), preserveFinalNewline(document, LOWER));
    assert.equal(document.version, untrustedVersion);

    await replaceWholeDocument(
      document,
      preserveFinalNewline(document, LOWER),
    );
    await vscode.commands.executeCommand("inlineSql.test.configureHooks", {
      forcedApplyResult: false,
    });
    const applyFalseVersion = document.version;
    await vscode.commands.executeCommand("inlineSql.formatAll");
    assert.equal(document.getText(), preserveFinalNewline(document, LOWER));
    assert.equal(document.version, applyFalseVersion);
  } finally {
    await vscode.commands.executeCommand("inlineSql.test.configureHooks", {});
    await vscode.commands.executeCommand("inlineSql.test.releaseBeforeApply");
  }
}

export async function testUntrustedHighlightOnly(): Promise<void> {
  assert.equal(vscode.workspace.isTrusted, false);
  const document = await openStandaloneFixture("python");
  const editor = await vscode.window.showTextDocument(document);
  selectNeedle(document, editor, false);
  const before = document.getText();
  const actions = await vscode.commands.executeCommand<
    readonly vscode.CodeAction[] | undefined
  >(
    "vscode.executeCodeActionProvider",
    document.uri,
    editor.selection,
    vscode.CodeActionKind.RefactorRewrite.value,
  );
  assert.equal(
    actions?.some((action) => action.title === "Format inline SQL") ?? false,
    false,
  );
  await vscode.commands.executeCommand("inlineSql.formatAtCursor");
  assert.equal(document.getText(), before);
  const hooks = await vscode.commands.executeCommand<HookSnapshot>(
    "inlineSql.test.readHooks",
  );
  assert.deepEqual(hooks.spawnCounts, { version: 0, helper: 0 });
}

async function assertOfficialSemanticCompatibility(
  document: vscode.TextDocument,
): Promise<void> {
  const result = await vscode.commands.executeCommand<
    vscode.SemanticTokens | vscode.SemanticTokensEdits | undefined
  >("vscode.provideDocumentSemanticTokens", document.uri);
  if (
    result === undefined ||
    !("data" in result) ||
    result.data.length === 0
  ) {
    throw new Error("registered semantic provider returned no full tokens");
  }
  assertNoSemanticSqlOverlap(
    decodeSemanticTokens(document, result),
    [physicalSqlRange(document)],
  );
}

export async function testOfficialExtensionCompatibility(): Promise<void> {
  for (const id of [
    "ms-python.python",
    "ms-toolsai.jupyter",
    "marimo-team.vscode-marimo",
  ]) {
    const extension = vscode.extensions.getExtension(id);
    if (extension === undefined) throw new Error(`missing ${id}`);
    await extension.activate();
  }
  await testStandaloneFormatting();
  const semanticDocument = await openStandaloneFixture("python");
  assert.equal(semanticDocument.languageId, "python");
  await replaceWholeDocument(
    semanticDocument,
    preserveFinalNewline(semanticDocument, UPPER),
  );
  await vscode.window.showTextDocument(semanticDocument);
  await assertOfficialSemanticCompatibility(semanticDocument);
  const jupyter = await openJupyterCell(jupyterFixtureUri(), 0);
  await assertThreeCommandsAndCodeAction(jupyter);
  const marimoUri = vscode.Uri.joinPath(workspaceRoot(), "marimo.py");
  const openedMarimo = waitForNotebookDocument(marimoUri, 30_000);
  await vscode.commands.executeCommand(
    "vscode.openWith",
    marimoUri,
    "marimo-notebook",
  );
  const marimoNotebook = await openedMarimo;
  assert.equal(marimoNotebook.notebookType, "marimo-notebook");
  const codeCellIndex = marimoNotebook
    .getCells()
    .findIndex((cell) => cell.kind === vscode.NotebookCellKind.Code);
  if (codeCellIndex < 0) {
    throw new Error("official marimo serializer returned no code cell");
  }
  const marimo = await focusNotebookCell(
    marimoNotebook,
    codeCellIndex,
  );
  assert.equal(marimo.cell.document.languageId, "mo-python");
  await assertThreeCommandsAndCodeAction(marimo);
}
```

  Put the VS Code-dependent shared helpers (`LOWER` through
  `assertThreeCommandsAndCodeAction`) in `vscode-harness.ts` and export them; each
  named suite body lives in the matching `test/integration/*.test.ts` file and imports
  those helpers. Import `node:assert/strict`, `node:path`, `vscode`, and Task 19's
  semantic helpers explicitly in the owning files. The normal semantic suite requires
  the deterministic probe; compatibility requires a non-empty full result from the
  activated official Python provider and rejects `undefined`, delta-only, or empty
  results so the weekly check cannot pass vacuously.

- [ ] Implement `scenarioTests()` as a fixed switch with direct function imports.
  Trusted runs standalone, notebook, semantic, and race suites; untrusted runs only
  trust/highlight/no-process assertions; compatibility runs official-extension scope,
  semantic, notebook, and formatting assertions. Register the marimo serializer only
  around suites that synthesize marimo data and dispose it in `finally`.

```ts
function assertNeverScenario(value: never): never {
  void value;
  throw new Error("unreachable integration scenario");
}

function scenarioTests(
  scenario: IntegrationScenario,
): readonly (() => Promise<void>)[] {
  switch (scenario) {
    case "trusted":
      return [
        testStandaloneFormatting,
        testNotebookFormatting,
        testSemanticTokenIsolation,
        testApplyRaces,
      ];
    case "untrusted":
      return [testUntrustedHighlightOnly];
    case "compatibility":
      return [testOfficialExtensionCompatibility];
    default:
      return assertNeverScenario(scenario);
  }
}
```

- [ ] Run the synthetic matrix on VS Code 1.95.0 and stable. Use installed Python
  3.12+ explicitly in test settings so PATH variance does not hide resolver defects.

```bash
integration_python="$(uv python find 3.12)"
for vscode_version in 1.95.0 stable; do
  INLINE_SQL_TEST_PYTHON="$integration_python" \
    VSCODE_TEST_VERSION="$vscode_version" bun run test:integration:trusted
  INLINE_SQL_TEST_PYTHON="$integration_python" \
    VSCODE_TEST_VERSION="$vscode_version" bun run test:integration:untrusted
done
```

- [ ] Run all TypeScript, grammar, Python, integration, lint, and type checks.

```bash
bun run test:unit
VSCODE_TEST_VERSION=1.95.0 bun run test:grammar
VSCODE_TEST_VERSION=stable bun run test:grammar
uv run pytest test/python -q
bun run lint
bun run typecheck
uv run ruff check .
uv run ruff format --check .
uv run ty check
```

- [ ] Commit.

```bash
git add tools/run_vscode_tests.ts test/support/integration-scenario.ts \
  test/support/vscode-harness.ts test/support/semantic-tokens.ts \
  test/integration test/fixtures/notebooks test/fixtures/extensions \
  test/fixtures/workspaces test/ts/run-vscode-tests.test.ts package.json
git commit -m "test: cover Python and notebook integration"
```

## Task 20: Build and verify the offline VSIX

**Files:**

- Create: `.vscodeignore`
- Create: `LICENSE`
- Create: `README.md`
- Create: `CHANGELOG.md`
- Create: `SECURITY.md`
- Create: `SUPPORT.md`
- Create: `third_party/vscode-python-extension/LICENSE.md`
- Create: `third_party/vscode-python-extension/SOURCE.json`
- Create: `third_party/runtime-components.json`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `tools/verify_vsix.py`
- Create: `tools/install_and_smoke_vsix.ts`
- Create: `tools/offline_vsix_smoke.py`
- Create: `test/fixtures/helper/offline-request.json`
- Create: `test/fixtures/extensions/vsix-driver/package.json`
- Create: `test/fixtures/extensions/vsix-driver/extension.js`
- Create: `test/python/test_vsix.py`
- Create: `test/ts/install-and-smoke-vsix.test.ts`
- Create: `test/integration/vsix-smoke.test.ts`
- Modify: `tools/build.ts`
- Modify: `package.json`

**Allowed runtime roots:**

```text
[Content_Types].xml
extension.vsixmanifest
extension/package.json
extension/package.nls.json
extension/package.nls.ja.json
extension/readme.md
extension/changelog.md
extension/LICENSE.txt
extension/SECURITY.md
extension/SUPPORT.md
extension/THIRD_PARTY_NOTICES.md
extension/dist/extension.js
extension/python/bootstrap.py
extension/python/inline_sql_helper/
extension/python/vendor/sqlparse/
extension/syntaxes/
extension/third_party/
```

Directory prefixes are not blanket allowlists. `verify_vsix.py` constructs an exact
recursive inventory for first-party/runtime metadata:

```py
EXACT_FIRST_PARTY_MEMBERS = frozenset(
    {
        "extension/python/inline_sql_helper/__init__.py",
        "extension/python/inline_sql_helper/candidate_formatter.py",
        "extension/python/inline_sql_helper/cli.py",
        "extension/python/inline_sql_helper/detection.py",
        "extension/python/inline_sql_helper/engine.py",
        "extension/python/inline_sql_helper/literals.py",
        "extension/python/inline_sql_helper/model.py",
        "extension/python/inline_sql_helper/positions.py",
        "extension/python/inline_sql_helper/protection.py",
        "extension/python/inline_sql_helper/protocol.py",
        "extension/python/inline_sql_helper/sqlparse_adapter.py",
        "extension/python/inline_sql_helper/token_bundles.py",
        "extension/syntaxes/inline-sql-fstring-islands.tmLanguage.json",
        "extension/syntaxes/inline-sql-python.tmLanguage.json",
        "extension/third_party/runtime-components.json",
        "extension/third_party/sqlparse/AUTHORS",
        "extension/third_party/sqlparse/LICENSE",
        "extension/third_party/sqlparse/SOURCE.json",
        "extension/third_party/sqlparse/files.sha256",
        "extension/third_party/vscode-python-extension/LICENSE.md",
        "extension/third_party/vscode-python-extension/SOURCE.json",
    }
)
```

The vendor members must equal the sorted paths and SHA-256 values declared by
`extension/third_party/sqlparse/files.sha256`, prefixed with
`extension/python/vendor/sqlparse/`. Any undeclared file inside an otherwise allowed
directory is rejected.

- [ ] Before packaging, add the complete MIT project license, a concise user-facing
  README with the three commands and five settings, a 0.1.0 changelog, repository
  security-advisory reporting guidance, source-free support guidance, and complete
  third-party notices. These files must contain no provisional text and must already
  state Python 3.12+, manual-only formatting, highlight-only untrusted behavior,
  non-validating SQL formatting, and no network/database/telemetry use. Task 22 will
  expand examples and development/release guidance without changing these claims.
- [ ] Write archive verifier tests first using synthetic ZIP/VSIX files. Reject missing
  helper/vendor/license/provenance, unexpected `.ts`, source maps, lockfiles, tests,
  documentation specs/plans, `.pyc`, `__pycache__`, absolute path strings, secret-like
  fixture values, symlinks, duplicate members, changed vendor hashes, wrong `main`,
  wrong engine, and runtime files outside the allowlist.
  Add one unexpected file inside each apparently allowed directory:
  `inline_sql_helper/extra.py`, `syntaxes/extra.json`,
  `third_party/extra.bin`, and `vendor/sqlparse/extra.py`; every case must fail.
  Add compressed archive >64 MiB, member >32 MiB, expanded total >128 MiB,
  compression ratio >200, and declared/actual size mismatch cases; validation must
  reject each before unbounded read or extraction.
- [ ] Test `offline_vsix_smoke.py` with an injected process runner and temporary root:
  a valid archive produces one `docker run --rm --network none --read-only` argument
  vector; an unsafe archive produces no Docker call and leaves no extracted tree.
  Replace the VSIX path after `validate_vsix()` and prove extraction still uses the
  validated in-memory bytes. Make the runner raise `TimeoutExpired` and assert a fixed,
  source-free `OfflineSmokeError` plus temporary-tree cleanup.
- [ ] Treat `[Content_Types].xml` and `extension.vsixmanifest` as required VSIX metadata.
  Verify the lowercase `extension/readme.md` and `extension/changelog.md` names emitted
  by `vsce`, plus its `extension/LICENSE.txt` normalization, rather than assuming source
  filename names and case survive packaging.
- [ ] Add a manifest/bundle test asserting `@vscode/python-extension` 1.0.5 is bundled
  in `dist/extension.js`, its MIT license and source record are included, and the VSIX
  has no `node_modules`. Assert sqlparse BSD-3-Clause license/authors/source/hash records
  are included.
- [ ] Run archive tests and confirm failure before verifier and ignore rules exist.

```bash
uv run pytest test/python/test_vsix.py -q
```

- [ ] Configure esbuild to bundle TypeScript source and runtime npm dependency into
  `dist/extension.js` as CommonJS, platform Node, target Node 20, externalizing only
  the VS Code host module. Disable source maps and legal-comment extraction because
  licenses are copied explicitly.
- [ ] Configure `.vscodeignore` to exclude source TypeScript, tests, lockfiles,
  development tooling, caches, coverage, reports, specs/plans, and source maps while
  retaining the exact runtime roots. Package with no dependency traversal.

```bash
bun run build
bun x vsce package --no-dependencies \
  --out dist-vsix/inline-sql-toolkit-0.1.0.vsix
uv run python tools/verify_vsix.py \
  dist-vsix/inline-sql-toolkit-0.1.0.vsix
```

- [ ] Implement one reusable archive validator. Reject duplicate names before building
  a set, reject backslashes, absolute/traversal/NUL names and symlink modes, parse the
  packaged vendor hash inventory, then require exact equality with fixed members plus
  declared vendor members. Validate packaged `main`, engine, version, and absence of
  `node_modules`; hash every declared vendor byte directly from the ZIP.

```py
@dataclass(frozen=True, slots=True)
class ValidatedVsix:
    archive_bytes: bytes
    members: tuple[str, ...]
    vendor_hashes: Mapping[str, str]
    expanded_bytes: int


MAX_VSIX_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 128 * 1024 * 1024
MAX_MEMBER_BYTES = 32 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200


def safe_member_name(info: zipfile.ZipInfo) -> str:
    name = info.filename
    path = PurePosixPath(name)
    mode = info.external_attr >> 16
    if (
        "\x00" in name
        or "\\" in name
        or path.is_absolute()
        or ".." in path.parts
        or stat.S_ISLNK(mode)
    ):
        raise VsixError("unsafe archive member")
    return path.as_posix()


def read_bounded_member(archive: zipfile.ZipFile, name: str) -> bytes:
    try:
        info = archive.getinfo(name)
    except KeyError:
        raise VsixError("required archive member is missing") from None
    if info.file_size > MAX_MEMBER_BYTES:
        raise VsixError("VSIX member size limit exceeded")
    with archive.open(info) as stream:
        payload = stream.read(info.file_size + 1)
    if len(payload) != info.file_size:
        raise VsixError("VSIX member size mismatch")
    return payload


def read_bounded_vsix(path: Path) -> bytes:
    with path.open("rb") as stream:
        payload = stream.read(MAX_VSIX_BYTES + 1)
    if len(payload) > MAX_VSIX_BYTES:
        raise VsixError("VSIX compressed size limit exceeded")
    return payload


def validate_vsix(path: Path) -> ValidatedVsix:
    archive_bytes = read_bounded_vsix(path)
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        infos = tuple(archive.infolist())
        names = [safe_member_name(info) for info in infos]
        if len(names) != len(set(names)):
            raise VsixError("duplicate archive member")
        expanded_bytes = sum(info.file_size for info in infos if not info.is_dir())
        if expanded_bytes > MAX_EXPANDED_BYTES:
            raise VsixError("VSIX expanded size limit exceeded")
        for info in infos:
            if info.file_size > MAX_MEMBER_BYTES:
                raise VsixError("VSIX member size limit exceeded")
            if (
                info.file_size > 0
                and info.compress_size == 0
                or info.compress_size > 0
                and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO
            ):
                raise VsixError("VSIX compression ratio limit exceeded")
        vendor_hashes = parse_vendor_inventory(
            read_bounded_member(
                archive,
                "extension/third_party/sqlparse/files.sha256",
            )
        )
        vendor_members = {
            f"extension/python/vendor/sqlparse/{relative}"
            for relative in vendor_hashes
        }
        expected = REQUIRED_PACKAGE_MEMBERS | EXACT_FIRST_PARTY_MEMBERS | vendor_members
        file_names = {
            name
            for name, info in zip(names, infos, strict=True)
            if not info.is_dir()
        }
        directory_names = set(names) - file_names
        allowed_directories = {
            ancestor
            for member in expected
            for ancestor in posix_ancestors(member)
        }
        if file_names != expected or not directory_names <= allowed_directories:
            raise VsixError("archive inventory mismatch")
        manifest = json.loads(
            read_bounded_member(archive, "extension/package.json")
        )
        validate_packaged_manifest(manifest)
        for relative, expected_hash in vendor_hashes.items():
            payload = read_bounded_member(
                archive,
                f"extension/python/vendor/sqlparse/{relative}",
            )
            if hashlib.sha256(payload).hexdigest() != expected_hash:
                raise VsixError("vendored file hash mismatch")
        scan_for_forbidden_runtime_content(archive, file_names)
        return ValidatedVsix(
            archive_bytes,
            tuple(sorted(file_names)),
            vendor_hashes,
            expanded_bytes,
        )
```

  `REQUIRED_PACKAGE_MEMBERS`, `parse_vendor_inventory`,
  `validate_packaged_manifest`, `posix_ancestors`, and
  `scan_for_forbidden_runtime_content` are small pure functions with direct synthetic
  archive tests; they never extract the archive.

- [ ] Implement verifier output that creates
  `reports/vsix-components.osv.json` from the actual archive contents, listing the
  bundled npm facade and vendored PyPI package with exact versions. The report is a
  build artifact, not a trusted input. Emit OSV-Scanner's custom lockfile format
  exactly:

```json
{
  "results": [
    {
      "packages": [
        {
          "package": {
            "name": "@vscode/python-extension",
            "version": "1.0.5",
            "ecosystem": "npm"
          }
        },
        {
          "package": {
            "name": "sqlparse",
            "version": "0.5.5",
            "ecosystem": "PyPI"
          }
        }
      ]
    }
  ]
}
```
- [ ] Write install smoke tests that use isolated extension and user-data directories
  on each OS, install only the VSIX, open a fixture, invoke a command, verify formatting,
  and verify a single undo. Use `test/fixtures/extensions/vsix-driver` as the only
  `extensionDevelopmentPath`; it drives public commands against the installed VSIX and
  never imports the repository's product extension. Do not use the repository root as
  `extensionDevelopmentPath`, and do not read product source files outside the unpacked
  VSIX.
- [ ] Add an offline helper smoke: extract the real VSIX, mount it read-only into an
  Ubuntu container with `--network none`, send a fixture request over stdin, and assert
  a valid edit response using vendored 0.5.5. Assert the container writes no source
  file and needs no `pip install`.
- [ ] Implement that flow in `offline_vsix_smoke.py`. First call the same archive
  validation used by `verify_vsix.py`; then use `tempfile.TemporaryDirectory()` and a
  path-traversal/duplicate/symlink-safe extractor; resolve the extracted bootstrap
  below that temporary root; invoke Docker with an argument array and `shell=False`;
  always let the temporary-directory context clean up. Never extract into
  `dist-vsix/`, the workspace root, or a caller-supplied broad directory.

```py
def extract_validated_vsix(
    validated: ValidatedVsix,
    destination: Path,
) -> Path:
    root = destination.resolve()
    extracted_bytes = 0
    with zipfile.ZipFile(io.BytesIO(validated.archive_bytes)) as archive:
        for member in validated.members:
            target = (root / PurePosixPath(member)).resolve()
            if not target.is_relative_to(root):
                raise VsixError("archive member escapes extraction root")
            target.parent.mkdir(parents=True, exist_ok=True)
            info = archive.getinfo(member)
            written = 0
            with archive.open(info) as source, target.open("xb") as output:
                while chunk := source.read(1024 * 1024):
                    written += len(chunk)
                    extracted_bytes += len(chunk)
                    if (
                        written > info.file_size
                        or extracted_bytes > validated.expanded_bytes
                    ):
                        raise VsixError("archive extraction size mismatch")
                    output.write(chunk)
            if written != info.file_size:
                raise VsixError("archive member size mismatch")
    if extracted_bytes != validated.expanded_bytes:
        raise VsixError("archive expanded size mismatch")
    extension_root = (root / "extension").resolve()
    if not extension_root.is_relative_to(root):
        raise VsixError("invalid extracted extension root")
    return extension_root


def run_offline_smoke(
    vsix: Path,
    request: bytes,
    image: str,
    runner: ProcessRunner = subprocess.run,
) -> None:
    validated = validate_vsix(vsix)
    with tempfile.TemporaryDirectory(prefix="inline-sql-vsix-") as temporary:
        extension_root = extract_validated_vsix(validated, Path(temporary))
        command = [
            "docker",
            "run",
            "--rm",
            "--pull=never",
            "--network",
            "none",
            "--read-only",
            "-i",
            "--mount",
            f"type=bind,src={extension_root},dst=/extension,readonly",
            image,
            "python",
            "-I",
            "-S",
            "-B",
            "-X",
            "utf8",
            "/extension/python/bootstrap.py",
        ]
        try:
            result = runner(
                command,
                input=request,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                shell=False,
                timeout=30,
            )
        except subprocess.TimeoutExpired:
            raise OfflineSmokeError("offline smoke timed out") from None
        validate_offline_response(result)
```

```bash
bun run test:vsix-install -- \
  dist-vsix/inline-sql-toolkit-0.1.0.vsix
uv run python tools/offline_vsix_smoke.py \
  --vsix dist-vsix/inline-sql-toolkit-0.1.0.vsix \
  --request test/fixtures/helper/offline-request.json \
  --image python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de
```

- [ ] Run vendor, archive, manifest, install, and offline checks. Inspect the final
  archive listing manually once.

```bash
uv run python tools/verify_vendor.py
uv run pytest test/python/test_vsix.py test/python/test_vendor_sqlparse.py -q
bun run test:unit -- test/ts/manifest.test.ts
bun run package:vsix
unzip -l dist-vsix/inline-sql-toolkit-0.1.0.vsix
uv run ruff check .
uv run ruff format --check .
uv run ty check
bun run lint
bun run typecheck
```

- [ ] Commit source, provenance, tests, and package rules; do not commit generated
  `dist/`, `dist-vsix/`, or `reports/`.

```bash
git add .vscodeignore LICENSE README.md CHANGELOG.md SECURITY.md SUPPORT.md \
  THIRD_PARTY_NOTICES.md third_party \
  tools/build.ts tools/verify_vsix.py tools/install_and_smoke_vsix.ts \
  tools/offline_vsix_smoke.py \
  test/fixtures/helper/offline-request.json \
  test/fixtures/extensions/vsix-driver test/python/test_vsix.py \
  test/integration/vsix-smoke.test.ts \
  test/ts/install-and-smoke-vsix.test.ts package.json
git commit -m "build: package a verified offline VSIX"
```

## Task 21: Add cross-platform CI, compatibility, performance, and OSV gates

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/compatibility.yml`
- Create: `.github/workflows/osv-scanner-pr.yml`
- Create: `.github/workflows/osv-scanner-scheduled.yml`
- Create: `tools/benchmark_helper.py`
- Modify: `tools/run_vscode_tests.ts`
- Modify: `tools/verify_vendor.py`
- Modify: `test/integration/compatibility.test.ts`
- Create: `test/python/test_benchmark_helper.py`
- Modify: `test/python/test_vendor_sqlparse.py`
- Create: `test/ts/workflows.test.ts`
- Modify: `package.json`

**Pinned Actions:**

```text
actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd
actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
actions/setup-node@2028fbc5c25fe9cf00d9f06a71cc4710d4507903
actions/setup-python@e797f83bcb11b83ae66e0230d6156d7c80228e7c
actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f
astral-sh/setup-uv@c771a70e6277c0a99b617c7a806ffedaca235ff9
oven-sh/setup-bun@3d267786b128fe76c2f16a390aa2448b815359f3
google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@9a498708959aeaef5ef730655706c5a1df1edbc2
google/osv-scanner-action/.github/workflows/osv-scanner-reusable-pr.yml@9a498708959aeaef5ef730655706c5a1df1edbc2
```

- [ ] Add workflow contract tests to `test/ts/workflows.test.ts` before creating
  workflows. Use the pinned `yaml` parser and assert every
  third-party Action uses a full commit SHA, top-level permissions are
  `contents: read`, pull-request concurrency cancels stale runs, installs are frozen,
  package jobs depend on quality/test jobs, and generated artifacts are never executed
  before verification. Assert every `setup-bun` use declares
  `bun-version: "1.3.8"` and every `setup-uv` use declares `version: "0.9.28"`.
  Permit `actions: read` and `security-events: write` only on jobs that call an OSV
  reusable workflow and upload SARIF.
- [ ] Create `ci.yml` with this dependency graph:
  `quality` → `python-test` + `grammar-gate`; `python-test` → `performance`;
  `python-test` + `grammar-gate` → `integration`; `integration` + `performance` →
  `package` → `vsix-install-smoke` + `offline-smoke`. Use Node 22 for tooling and
  check the built bundle under Node 20. Use
  `bun install --frozen-lockfile --ignore-scripts` and `uv sync --frozen`.
- [ ] Add `ci:quality` to `package.json` as
  `bun run format:check && bun run lint && bun run typecheck && bun run test:coverage`.
  Workflow matrix entries set `VSCODE_TEST_VERSION` explicitly instead of relying on
  shell-specific inline environment syntax.
- [ ] Define Python matrix `ubuntu-latest`, `macos-latest`, `windows-latest` ×
  3.12, 3.13, 3.14. Define grammar matrix VS Code 1.95.0 and stable. Define integration
  matrix all three OSes × both VS Code versions × trusted/untrusted. Use
  `xvfb-run -a` on Linux. Every Python matrix entry runs pytest,
  `ruff check .`, `ruff format --check .`, and `ty check` after `uv sync --frozen`;
  workflow contract tests assert `python-test` is a required ancestor of `package`.
- [ ] Add a deterministic 100 KiB triple-quoted SQL performance fixture. On Ubuntu with
  Python 3.12, record median helper time in the job summary, mark one second as the
  regression target, and fail only at the five-second hard limit.
- [ ] Implement the fixture and runner in `tools/benchmark_helper.py`. Generate in
  memory a parseable Python document whose UTF-8 size is exactly 102,400 bytes and whose
  sole candidate is a triple-quoted `SELECT` query; run the production bootstrap seven
  times after one warm-up; report median, minimum, maximum, Python version, and byte
  count as source-free JSON. `test_benchmark_helper.py` verifies exact bytes,
  determinism, seven samples, median calculation, source-free output, and a fake
  duration crossing 5.0 seconds.

```py
def build_document(byte_count: int) -> str:
    prefix = b'query = """SELECT 1'
    suffix = b'"""\n'
    padding = byte_count - len(prefix) - len(suffix)
    if padding < 1:
        raise BenchmarkError("document size is too small")
    payload = prefix + (b" " * padding) + suffix
    document = payload.decode("ascii")
    ast.parse(document)
    if len(document.encode("utf-8")) != byte_count:
        raise BenchmarkError("document byte count mismatch")
    return document


def benchmark(
    python: str,
    bootstrap: Path,
    iterations: int,
    document_bytes: int,
    hard_timeout_seconds: float,
    clock: Clock = time.perf_counter,
) -> BenchmarkReport:
    source = build_document(document_bytes)
    request = build_format_request(source)
    durations: list[float] = []
    for index in range(iterations + 1):
        started = clock()
        result = subprocess.run(
            [
                python,
                "-I",
                "-S",
                "-B",
                "-X",
                "utf8",
                str(bootstrap),
            ],
            input=request,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=hard_timeout_seconds,
            check=False,
        )
        duration = clock() - started
        validate_benchmark_response(result)
        if index > 0:
            durations.append(duration)
    return BenchmarkReport(
        document_bytes=document_bytes,
        samples=tuple(durations),
        median_seconds=statistics.median(durations),
        minimum_seconds=min(durations),
        maximum_seconds=max(durations),
        python_version=probe_python_version(python),
        regression_target_met=statistics.median(durations) <= 1.0,
    )
```

```bash
uv run python tools/benchmark_helper.py \
  --python python3 \
  --iterations 7 \
  --document-bytes 102400 \
  --hard-timeout-seconds 5 \
  --output reports/performance.json
```
- [ ] Make the package job upload the verified VSIX plus SHA-256, archive inventory,
  vendor inventory, third-party notices, and generated component report. The three OS
  smoke jobs download the same artifact and install it into isolated directories.
  Run the Docker `--network none` smoke on Ubuntu. Before that smoke, explicitly pull
  `python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de`
  in a network-enabled preparation step, inspect and record its repo digest, then invoke
  the smoke with the same digest and `--pull=never`. Workflow contract tests require
  the pull/inspect steps to precede offline smoke and reject an unpinned image.
- [ ] Create `compatibility.yml` on a weekly schedule and manual dispatch. On stable
  VS Code only, install the current official `ms-python.python`,
  `ms-toolsai.jupyter`, and `marimo-team.vscode-marimo`; verify notebook types,
  language IDs, scopes, and a format command through
  `test/integration/compatibility.test.ts` and the `compatibility` mode in
  `run_vscode_tests.ts`. Require a non-empty official Python semantic-token provider
  result and assert none of its tokens overrides a verified SQL segment; do not install
  the test semantic fixture in this job. Do not install current upstream extensions
  into the VS Code 1.95 job when their engine range excludes it.
- [ ] Create PR and scheduled OSV workflows using the pinned reusable workflow. Scan
  `bun.lock`, `uv.lock`, and the requirements-format projection
  `tools/sqlparse-vendor.requirements.txt`; separately verify that the projection
  matches `tools/sqlparse-vendor.lock` through
  `tools/verify_vendor.py --lock-projection-only`. Add that source-free validation mode
  and its test before writing the workflows. After packaging, scan the generated
  `reports/vsix-components.osv.json` so bundled components, not only development
  manifests, are covered.
- [ ] Pass source lockfiles with explicit scan arguments:

```text
--lockfile=bun.lock
--lockfile=uv.lock
--lockfile=requirements.txt:tools/sqlparse-vendor.requirements.txt
```

- [ ] Keep the packaged-component scan inside `ci.yml`, where it can depend on the
  package job. Upload `reports/vsix-components.osv.json` as artifact
  `vsix-osv-input`; a following reusable-workflow job declares `needs: package`, sets
  `download-artifact: vsix-osv-input`, and uses this sole scan argument:

```text
--lockfile=osv-scanner:vsix-components.osv.json
```

  Give that reusable job `contents: read`, `actions: read`, and
  `security-events: write`. Do not assume a separately triggered workflow can consume
  another workflow run's untrusted artifact.
- [ ] Validate YAML, run workflow contract tests, and execute all local jobs that do
  not require GitHub-hosted matrix runners.

```bash
bun run test:unit
bun run ci:quality
VSCODE_TEST_VERSION=1.95.0 bun run test:grammar
VSCODE_TEST_VERSION=stable bun run test:grammar
uv run pytest test/python -q
bun run package:vsix
uv run python tools/verify_vsix.py \
  dist-vsix/inline-sql-toolkit-0.1.0.vsix
```

- [ ] Commit.

```bash
git add .github/workflows package.json tools/benchmark_helper.py \
  tools/run_vscode_tests.ts tools/verify_vendor.py \
  test/integration/compatibility.test.ts \
  test/python/test_benchmark_helper.py test/python/test_vendor_sqlparse.py \
  test/ts/workflows.test.ts
git commit -m "ci: enforce compatibility and security gates"
```

## Task 22: Document the product and run final acceptance verification

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `SECURITY.md`
- Modify: `SUPPORT.md`
- Create: `docs/development.md`
- Create: `docs/releasing.md`
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: `package.json`
- Modify: `test/ts/manifest.test.ts`

- [ ] Write documentation assertions first in `test/ts/manifest.test.ts`: every command
  and setting appears in README; Python 3.12 minimum, detection rules, supported
  prefixes/delimiters, `.py`/Jupyter/marimo scope, unsupported SQL cells/magic/bytes/
  concatenation/t-string/invalid Python, manual-only operation, non-validating
  `sqlparse`, trust behavior, privacy, offline behavior, and troubleshooting are stated.
  Assert package links reference files that will be present in VSIX.
- [ ] Verify the existing MIT project license. Expand `THIRD_PARTY_NOTICES.md` with
  sqlparse BSD-3-Clause and bundled Microsoft Python Extension API facade MIT notices
  and exact provenance links. Do not claim ownership of third-party files.
- [ ] Write README usage examples for a plain string, marker triple string, and complex
  f-string. Explain that formatter detection is source-level, SQL is never executed or
  validated, no dialect is inferred, unsafe candidates are skipped, and untrusted
  workspaces receive highlighting only. Explain that document version and expected
  source are checked before one `WorkspaceEdit`, while VS Code offers no atomic
  versioned precondition for edits occurring after that check.
- [ ] Write `docs/development.md` with prerequisites, frozen Bun/uv setup, grammar gate
  hard-stop procedure, vendor refresh/check, unit/property/integration commands,
  package inspection, and privacy rules. Pin prerequisites to Bun 1.3.8 and uv 0.9.28,
  matching `packageManager` and CI. Write `docs/releasing.md` with version and
  changelog update, OSV, full matrix, VSIX verification/install/offline smoke,
  SHA-256 artifact generation, confirmation that `hidenobunagai` is the intended
  Marketplace publisher identity, and an explicit separate approval step before any
  Marketplace publication.
- [ ] Write `SECURITY.md` with supported-version and private-reporting guidance without
  inventing a contact address; direct reports to the repository's private security
  advisory UI. Write `SUPPORT.md` with diagnostic reason codes and source-free
  reporting guidance. Write `CHANGELOG.md` for 0.1.0.
- [ ] Run documentation, manifest, license, and package tests.

```bash
bun run test:unit -- test/ts/manifest.test.ts
uv run pytest \
  test/python/test_vendor_sqlparse.py \
  test/python/test_vsix.py -q
bun run package:vsix
```

- [ ] Commit documentation.

```bash
git add LICENSE README.md CHANGELOG.md SECURITY.md SUPPORT.md \
  THIRD_PARTY_NOTICES.md docs/development.md docs/releasing.md package.json \
  test/ts/manifest.test.ts
git commit -m "docs: document inline SQL usage and release safety"
```

- [ ] Invoke `superpowers:requesting-code-review` and address only evidence-backed
  findings using `superpowers:receiving-code-review`. Re-run the affected task tests
  after every correction.
- [ ] Invoke `superpowers:verification-before-completion` and perform a clean,
  frozen dependency restore followed by the complete local verification sequence.

```bash
bun install --frozen-lockfile --ignore-scripts
uv sync --frozen --python 3.12
bun run format:check
bun run lint
bun run typecheck
bun run test:coverage
VSCODE_TEST_VERSION=1.95.0 bun run test:grammar
VSCODE_TEST_VERSION=stable bun run test:grammar
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest --cov
VSCODE_TEST_VERSION=1.95.0 bun run test:integration:trusted
VSCODE_TEST_VERSION=1.95.0 bun run test:integration:untrusted
VSCODE_TEST_VERSION=stable bun run test:integration:trusted
VSCODE_TEST_VERSION=stable bun run test:integration:untrusted
bun run package:vsix
uv run python tools/verify_vendor.py
uv run python tools/verify_vsix.py \
  dist-vsix/inline-sql-toolkit-0.1.0.vsix
bun run test:vsix-install -- \
  dist-vsix/inline-sql-toolkit-0.1.0.vsix
uv run python tools/offline_vsix_smoke.py \
  --vsix dist-vsix/inline-sql-toolkit-0.1.0.vsix \
  --request test/fixtures/helper/offline-request.json \
  --image python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de
git diff --check
git status --short
```

- [ ] Run the Python suite separately on 3.13 and 3.14 after the 3.12 coverage run.

```bash
uv run --python 3.13 pytest test/python -q
uv run --python 3.14 pytest test/python -q
```

- [ ] Inspect the real VSIX inventory, licenses, generated component report, SHA-256,
  and offline smoke evidence. Confirm no TypeScript/development source, absolute build
  path, fixture secret, cache, bytecode, test, plan, or unapproved runtime dependency
  is packaged; the allowlisted Python helper `.py` files are required runtime code.
- [ ] Confirm `git status --short` contains only intentionally untracked local files,
  with the pre-existing `.DS_Store` never staged. Record the final commit SHA and
  verification commands in the handoff. Do not publish to Marketplace without a new,
  explicit user instruction.

## 4. Requirement-to-Task Traceability

| Requirement | Primary tasks |
| --- | --- |
| TextMate SQL/Python island scopes and PEP 701 hard gate | 1, 2, 19 |
| Marker/keyword detection parity | 2, 7 |
| Plain/raw/f/rf/fr strings and exclusions | 2, 5, 6, 11 |
| Exact f-string/escape/brace preservation | 6, 8, 11 |
| `sqlparse` 0.5.5, layout rules, idempotency | 9, 10, 11 |
| Cursor/selection/all and partial success | 12, 17, 19 |
| UTF-8/code point/UTF-16 correctness | 4, 12, 17 |
| Python resolver and version 3.12+ | 15 |
| One-shot protocol, isolation, timeout/cancel | 3, 13, 16 |
| Workspace Trust and restricted path | 14, 15, 18, 19 |
| Jupyter and marimo cell targeting | 14, 18, 19, 21 |
| Atomic edit/race/undo behavior | 17, 19 |
| Commands/Code Action and no formatter provider | 18, 19 |
| Resource guards and privacy | 12, 13, 16, 17, 20 |
| Offline VSIX, provenance, licenses, OSV | 9, 20, 21, 22 |
| Cross-platform/version CI and performance | 19, 21, 22 |

## 5. Execution Notes

- Task 1 alone may invalidate the chosen architecture. Treat its failure as useful
  design evidence, not as permission to weaken the acceptance cases.
- Task 3 fixes the cross-language wire contract before either side becomes large.
  Later protocol changes require fixture, schema, TypeScript, and Python updates in one
  task and one commit.
- Tasks 4–13 form the Python safety core. Their tests should run without VS Code.
- Tasks 14–18 form the VS Code orchestration layer. Use dependency-injected fakes for
  process, time, trust, configuration, editor, and workspace APIs.
- Task 19 proves behavior inside real extension hosts. Task 20 repeats the essential
  smoke against the packaged artifact, because source-tree integration success does not
  prove VSIX completeness.
- The implementation branch is ready for completion only after Task 22's verification
  output has been reviewed. A generated VSIX is a local artifact, not authorization to
  publish it.
