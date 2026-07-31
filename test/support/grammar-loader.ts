import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { fetchStableVersions } from "@vscode/test-electron/out/download.js";
import { createOnigScanner, createOnigString, loadWASM } from "vscode-oniguruma";
import {
  type IGrammar,
  INITIAL,
  type IRawGrammar,
  parseRawGrammar,
  Registry,
  type StateStack,
} from "vscode-textmate";

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

interface GrammarContribution {
  readonly scopeName: string;
  readonly path: string;
}

interface ExtensionManifest {
  readonly contributes?: {
    readonly grammars?: readonly GrammarContribution[];
    readonly languages?: readonly { readonly id: string }[];
    readonly notebooks?: readonly { readonly type: string }[];
  };
}

interface GrammarLock {
  readonly marimo: {
    readonly sha256: string;
  };
}

interface SourceToken {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly scopes: readonly string[];
  readonly languageId: number;
}

interface SourceLine {
  readonly text: string;
  readonly startIndex: number;
}

const PYTHON_LANGUAGE_ID = 1;
const SQL_LANGUAGE_ID = 2;
const LANGUAGE_ID_MASK = 0xff;
const FENCE_IDENTIFIER = "__inline_sql_scope_fence__";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vscodeRoots = new Map<GrammarVersion, Promise<string>>();
const grammars = new Map<string, Promise<IGrammar>>();
let expectedStableVersion: Promise<string> | undefined;

const onigLib = (async () => {
  const wasmPath = resolve(projectRoot, "node_modules/vscode-oniguruma/release/onig.wasm");
  await loadWASM(await readFile(wasmPath));
  return {
    createOnigScanner: (patterns: string[]) => createOnigScanner(patterns),
    createOnigString: (text: string) => createOnigString(text),
  };
})();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Expected ${field} to be an array of strings`);
  }
  return value;
}

function parseGrammarCase(value: unknown, index: number): GrammarCase {
  if (!isObject(value)) {
    throw new Error(`Expected grammar case ${index} to be an object`);
  }
  const language = requireString(value.language, `case ${index}.language`);
  if (language !== "python" && language !== "mo-python") {
    throw new Error(`Unsupported grammar case language: ${language}`);
  }
  if (!Array.isArray(value.segments)) {
    throw new Error(`Expected case ${index}.segments to be an array`);
  }
  const segments = value.segments.map((segment, segmentIndex): ScopedSegment => {
    if (!isObject(segment)) {
      throw new Error(`Expected case ${index} segment ${segmentIndex} to be an object`);
    }
    const embeddedLanguage = requireString(
      segment.embeddedLanguage,
      `case ${index} segment ${segmentIndex}.embeddedLanguage`,
    );
    if (embeddedLanguage !== "python" && embeddedLanguage !== "sql") {
      throw new Error(`Unsupported embedded language: ${embeddedLanguage}`);
    }
    return {
      text: requireString(segment.text, `case ${index} segment ${segmentIndex}.text`),
      requiredScopes: requireStringArray(
        segment.requiredScopes,
        `case ${index} segment ${segmentIndex}.requiredScopes`,
      ),
      forbiddenScopes: requireStringArray(
        segment.forbiddenScopes,
        `case ${index} segment ${segmentIndex}.forbiddenScopes`,
      ),
      embeddedLanguage,
    };
  });
  return {
    id: requireString(value.id, `case ${index}.id`),
    source: requireString(value.source, `case ${index}.source`),
    language,
    segments,
  };
}

export function loadGrammarCases(filename: string): readonly GrammarCase[] {
  if (filename.includes("/") || filename.includes("\\") || !filename.endsWith(".json")) {
    throw new Error("Grammar case filename must be a JSON basename");
  }
  const parsed = JSON.parse(
    readFileSync(resolve(projectRoot, "test/fixtures", filename), "utf8"),
  ) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Grammar case fixture must contain an array");
  }
  return parsed.map(parseGrammarCase);
}

export function assertDownloadedVSCodeVersion(
  requestedVersion: GrammarVersion,
  actualVersion: string,
  stableVersion?: string,
): void {
  if (requestedVersion === "stable") {
    if (stableVersion === undefined) {
      throw new Error("Expected stable VS Code version was not resolved independently");
    }
    if (actualVersion !== stableVersion) {
      throw new Error(
        `Expected stable VS Code ${stableVersion}, but downloaded installation reports ${actualVersion}`,
      );
    }
    return;
  }
  if (actualVersion !== requestedVersion) {
    throw new Error(
      `Requested VS Code ${requestedVersion}, but downloaded installation reports ${actualVersion}`,
    );
  }
}

async function resolveExpectedStableVersion(): Promise<string> {
  expectedStableVersion ??= (async () => {
    const versions = await fetchStableVersions(true, 30_000);
    const version = versions[0];
    if (version === undefined) {
      throw new Error("VS Code stable releases API returned no released versions");
    }
    return version;
  })();
  return expectedStableVersion;
}

async function vscodeAppRoot(version: GrammarVersion): Promise<string> {
  let pending = vscodeRoots.get(version);
  if (pending === undefined) {
    pending = (async () => {
      const [executable, stableVersion] = await Promise.all([
        downloadAndUnzipVSCode(version),
        version === "stable" ? resolveExpectedStableVersion() : Promise.resolve(undefined),
      ]);
      const appRoot =
        process.platform === "darwin"
          ? resolve(executable, "../../Resources/app")
          : resolve(dirname(executable), "resources/app");
      const manifest = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")) as {
        readonly version?: unknown;
      };
      const actualVersion = requireString(manifest.version, "VS Code package version");
      assertDownloadedVSCodeVersion(version, actualVersion, stableVersion);
      return appRoot;
    })();
    vscodeRoots.set(version, pending);
  }
  return pending;
}

export async function builtinGrammarPath(
  version: GrammarVersion,
  language: "python" | "sql",
): Promise<string> {
  const appRoot = await vscodeAppRoot(version);
  const extensionRoot = join(appRoot, "extensions", language);
  const manifest = JSON.parse(
    await readFile(join(extensionRoot, "package.json"), "utf8"),
  ) as ExtensionManifest;
  const contribution = manifest.contributes?.grammars?.find(
    ({ scopeName }) => scopeName === `source.${language}`,
  );
  if (contribution === undefined) {
    throw new Error(`Missing built-in ${language} grammar`);
  }
  const grammarPath = resolve(extensionRoot, contribution.path);
  assertPathBelow(extensionRoot, grammarPath, `built-in ${language} grammar`);
  return grammarPath;
}

function assertPathBelow(root: string, candidate: string, label: string): void {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`${label} resolves outside its extension root`);
  }
}

async function pinnedMarimoGrammarPath(): Promise<string> {
  const lock = JSON.parse(
    await readFile(resolve(projectRoot, "test/fixtures/grammar-lock.json"), "utf8"),
  ) as GrammarLock;
  const grammarPath = resolve(projectRoot, "test/fixtures/grammars/marimo-python.tmLanguage.json");
  const grammar = await readFile(grammarPath);
  const actualHash = createHash("sha256").update(grammar).digest("hex");
  if (actualHash !== lock.marimo.sha256) {
    throw new Error(
      `Pinned marimo grammar hash mismatch: expected ${lock.marimo.sha256}, received ${actualHash}`,
    );
  }
  return grammarPath;
}

async function installedMarimoGrammarPath(extensionRootInput: string): Promise<string> {
  const extensionRoot = await realpath(extensionRootInput);
  const manifest = JSON.parse(
    await readFile(join(extensionRoot, "package.json"), "utf8"),
  ) as ExtensionManifest;
  const languages = manifest.contributes?.languages?.filter(({ id }) => id === "mo-python") ?? [];
  const grammars =
    manifest.contributes?.grammars?.filter(({ scopeName }) => scopeName === "source.mo-python") ??
    [];
  const notebooks =
    manifest.contributes?.notebooks?.filter(({ type }) => type === "marimo-notebook") ?? [];
  if (languages.length !== 1) {
    throw new Error("Marimo extension must contribute exactly one mo-python language");
  }
  if (grammars.length !== 1) {
    throw new Error("Marimo extension must contribute exactly one source.mo-python grammar");
  }
  if (notebooks.length !== 1) {
    throw new Error("Marimo extension must contribute exactly one marimo-notebook");
  }
  const grammarContribution = grammars[0];
  if (grammarContribution === undefined) {
    throw new Error("Missing marimo grammar contribution");
  }
  const grammarPath = await realpath(resolve(extensionRoot, grammarContribution.path));
  assertPathBelow(extensionRoot, grammarPath, "marimo grammar");
  return grammarPath;
}

async function readRawGrammar(path: string): Promise<IRawGrammar> {
  return parseRawGrammar(await readFile(path, "utf8"), path);
}

async function loadCaseGrammar(
  version: GrammarVersion,
  language: GrammarCase["language"],
  options: GrammarLoadOptions,
): Promise<IGrammar> {
  const cacheKey = `${version}:${language}:${options.marimoExtensionRoot ?? "pinned"}`;
  let pending = grammars.get(cacheKey);
  if (pending === undefined) {
    pending = (async () => {
      const [pythonPath, sqlPath, marimoPath] = await Promise.all([
        builtinGrammarPath(version, "python"),
        builtinGrammarPath(version, "sql"),
        options.marimoExtensionRoot === undefined
          ? pinnedMarimoGrammarPath()
          : installedMarimoGrammarPath(options.marimoExtensionRoot),
      ]);
      const grammarPaths = new Map<string, string>([
        ["source.python", pythonPath],
        ["source.sql", sqlPath],
        ["source.mo-python", marimoPath],
        [
          "inline-sql.python.injection",
          resolve(projectRoot, "syntaxes/inline-sql-python.tmLanguage.json"),
        ],
        [
          "inline-sql.fstring-islands.injection",
          resolve(projectRoot, "syntaxes/inline-sql-fstring-islands.tmLanguage.json"),
        ],
      ]);
      const registry = new Registry({
        onigLib,
        loadGrammar: async (scopeName) => {
          const grammarPath = grammarPaths.get(scopeName);
          return grammarPath === undefined ? null : readRawGrammar(grammarPath);
        },
        getInjections: (scopeName) => {
          if (scopeName === "source.python" || scopeName === "source.mo-python") {
            return ["inline-sql.python.injection", "inline-sql.fstring-islands.injection"];
          }
          if (scopeName === "source.sql") {
            return ["inline-sql.fstring-islands.injection"];
          }
          return [];
        },
      });
      const loaded = await registry.loadGrammarWithConfiguration(
        language === "python" ? "source.python" : "source.mo-python",
        PYTHON_LANGUAGE_ID,
        {
          embeddedLanguages: {
            "meta.embedded.inline.python": PYTHON_LANGUAGE_ID,
            "meta.embedded.inline.sql": SQL_LANGUAGE_ID,
          },
        },
      );
      if (loaded === null) {
        throw new Error(`Unable to load ${language} grammar for VS Code ${version}`);
      }
      return loaded;
    })();
    grammars.set(cacheKey, pending);
  }
  return pending;
}

function sourceLines(source: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  const expression = /([^\r\n]*)(\r\n|\r|\n|$)/gu;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(source)) !== null) {
    const text = match[1];
    const lineEnding = match[2];
    if (text === undefined || lineEnding === undefined) {
      throw new Error("Unable to split grammar source into lines");
    }
    lines.push({ text, startIndex: match.index });
    if (lineEnding === "") {
      break;
    }
  }
  return lines;
}

function languageIdAt(encodedTokens: Uint32Array, index: number): number {
  let languageId = PYTHON_LANGUAGE_ID;
  for (let tokenIndex = 0; tokenIndex < encodedTokens.length; tokenIndex += 2) {
    const startIndex = encodedTokens[tokenIndex];
    const metadata = encodedTokens[tokenIndex + 1];
    if (startIndex === undefined || metadata === undefined) {
      throw new Error("Malformed encoded token stream");
    }
    if (startIndex > index) {
      break;
    }
    languageId = metadata & LANGUAGE_ID_MASK;
  }
  return languageId;
}

export async function tokenizeWithEmbeddedLanguages(
  version: GrammarVersion,
  testCase: GrammarCase,
  options: GrammarLoadOptions = {},
): Promise<readonly SourceToken[]> {
  const grammar = await loadCaseGrammar(version, testCase.language, options);
  const source = `${testCase.source}\n${FENCE_IDENTIFIER} = 1`;
  const tokens: SourceToken[] = [];
  let scopeRuleStack: StateStack = INITIAL;
  let encodedRuleStack: StateStack = INITIAL;
  for (const line of sourceLines(source)) {
    const scoped = grammar.tokenizeLine(line.text, scopeRuleStack);
    const encoded = grammar.tokenizeLine2(line.text, encodedRuleStack);
    scopeRuleStack = scoped.ruleStack;
    encodedRuleStack = encoded.ruleStack;
    for (const token of scoped.tokens) {
      tokens.push({
        startIndex: line.startIndex + token.startIndex,
        endIndex: line.startIndex + token.endIndex,
        scopes: token.scopes,
        languageId: languageIdAt(encoded.tokens, token.startIndex),
      });
    }
  }
  return tokens;
}

function scopeMatches(actualScope: string, expectedScope: string): boolean {
  return actualScope === expectedScope || actualScope.startsWith(`${expectedScope}.`);
}

function tokenTrace(tokens: readonly SourceToken[], start: number, end: number): string {
  return tokens
    .filter((token) => token.endIndex > start && token.startIndex < end)
    .map(
      (token) =>
        `[${token.startIndex},${token.endIndex}) language=${token.languageId} scopes=${token.scopes.join(
          " ",
        )}`,
    )
    .join("\n");
}

function assertRequiredSegments(tokens: readonly SourceToken[], testCase: GrammarCase): void {
  for (const segment of testCase.segments) {
    const start = testCase.source.indexOf(segment.text);
    if (start < 0) {
      throw new Error(`${testCase.id}: segment ${JSON.stringify(segment.text)} is absent`);
    }
    const end = start + segment.text.length;
    const relevantTokens = tokens.filter(
      (token) => token.endIndex > start && token.startIndex < end,
    );
    const expectedLanguageId =
      segment.embeddedLanguage === "python" ? PYTHON_LANGUAGE_ID : SQL_LANGUAGE_ID;
    for (let index = start; index < end; index += 1) {
      const character = testCase.source[index];
      if (character === undefined || /\s/u.test(character)) {
        continue;
      }
      const token = relevantTokens.find(
        (candidate) => candidate.startIndex <= index && candidate.endIndex > index,
      );
      if (token === undefined) {
        throw new Error(
          `${testCase.id}: no token covers ${JSON.stringify(segment.text)} at offset ${index}\n${tokenTrace(
            tokens,
            start,
            end,
          )}`,
        );
      }
      for (const requiredScope of segment.requiredScopes) {
        if (!token.scopes.some((scope) => scopeMatches(scope, requiredScope))) {
          throw new Error(
            `${testCase.id}: ${JSON.stringify(
              segment.text,
            )} is missing required scope ${requiredScope} at offset ${index}\n${tokenTrace(
              tokens,
              start,
              end,
            )}`,
          );
        }
      }
      for (const forbiddenScope of segment.forbiddenScopes) {
        if (token.scopes.some((scope) => scopeMatches(scope, forbiddenScope))) {
          throw new Error(
            `${testCase.id}: ${JSON.stringify(
              segment.text,
            )} has forbidden scope ${forbiddenScope} at offset ${index}\n${tokenTrace(
              tokens,
              start,
              end,
            )}`,
          );
        }
      }
      if (token.languageId !== expectedLanguageId) {
        throw new Error(
          `${testCase.id}: ${JSON.stringify(segment.text)} has embedded language ID ${
            token.languageId
          }, expected ${expectedLanguageId} at offset ${index}\n${tokenTrace(tokens, start, end)}`,
        );
      }
    }
  }
}

function assertNoScopeLeakAfterLiteral(
  tokens: readonly SourceToken[],
  testCase: GrammarCase,
): void {
  const fenceStart = testCase.source.length + 1;
  const fenceEnd = fenceStart + FENCE_IDENTIFIER.length;
  const fenceTokens = tokens.filter(
    (token) => token.endIndex > fenceStart && token.startIndex < fenceEnd,
  );
  if (fenceTokens.length === 0) {
    throw new Error(`${testCase.id}: post-literal scope fence was not tokenized`);
  }
  for (const token of fenceTokens) {
    const leaked = token.scopes.find(
      (scope) =>
        scopeMatches(scope, "meta.embedded.inline.sql") ||
        scopeMatches(scope, "meta.embedded.inline.python"),
    );
    if (leaked !== undefined || token.languageId !== PYTHON_LANGUAGE_ID) {
      throw new Error(
        `${testCase.id}: post-literal scope fence leaked ${leaked ?? "embedded language"}\n${tokenTrace(
          tokens,
          fenceStart,
          fenceEnd,
        )}`,
      );
    }
  }
}

export async function verifyPep701GrammarCase(
  version: GrammarVersion,
  testCase: GrammarCase,
  options: GrammarLoadOptions = {},
): Promise<void> {
  const tokens = await tokenizeWithEmbeddedLanguages(version, testCase, options);
  assertRequiredSegments(tokens, testCase);
  assertNoScopeLeakAfterLiteral(tokens, testCase);
}
