import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const prefixes = [
  "",
  "r",
  "R",
  "f",
  "F",
  "rf",
  "rF",
  "Rf",
  "RF",
  "fr",
  "fR",
  "Fr",
  "FR",
] as const;
export const delimiters = ["'", '"', "'''", '"""'] as const;

const FORMAT_EXPECTATIONS = ["supported", "unsupported-skip", "ignored", "parse-error"] as const;
const GRAMMAR_EXPECTATIONS = ["sql", "none", "implementation-defined"] as const;
const PYTHON_VERSIONS = ["3.12", "3.13", "3.14"] as const;
const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/sql-detection.json",
);

type FormatExpectation = (typeof FORMAT_EXPECTATIONS)[number];
type GrammarExpectation = (typeof GRAMMAR_EXPECTATIONS)[number];
type PythonVersion = (typeof PYTHON_VERSIONS)[number];

interface DetectionFixtureBase {
  readonly id: string;
  readonly detectionExpected: boolean;
  readonly formatExpectation: FormatExpectation;
  readonly formatExpectationByPython?: Readonly<Partial<Record<PythonVersion, FormatExpectation>>>;
  readonly grammarExpectation: GrammarExpectation;
  readonly reason: string;
}

export interface ContentDetectionFixture extends DetectionFixtureBase {
  readonly kind: "content";
  readonly content: string;
}

export interface SourceDetectionFixture extends DetectionFixtureBase {
  readonly kind: "source";
  readonly source: string;
}

export type DetectionFixture = ContentDetectionFixture | SourceDetectionFixture;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${field} to be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Expected ${field} to be a boolean`);
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`Expected ${field} to be one of ${values.join(", ")}`);
  }
  return value as T;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(
      `Expected ${field} keys ${sortedExpected.join(", ")}, received ${actual.join(", ")}`,
    );
  }
}

function parseFormatOverrides(
  value: unknown,
  field: string,
): Readonly<Partial<Record<PythonVersion, FormatExpectation>>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new Error(`Expected ${field} to be an object`);
  }
  for (const [version, expectation] of Object.entries(value)) {
    requireEnum(version, PYTHON_VERSIONS, `${field} key`);
    requireEnum(expectation, FORMAT_EXPECTATIONS, `${field}.${version}`);
  }
  return value;
}

function parseDetectionFixture(value: unknown, index: number): DetectionFixture {
  if (!isObject(value)) {
    throw new Error(`Expected detection fixture ${index} to be an object`);
  }
  const kind = requireEnum(value.kind, ["content", "source"] as const, `fixture ${index}.kind`);
  const optionalOverride =
    value.formatExpectationByPython === undefined ? [] : ["formatExpectationByPython"];
  assertExactKeys(
    value,
    [
      "id",
      "kind",
      kind,
      "detectionExpected",
      "formatExpectation",
      ...optionalOverride,
      "grammarExpectation",
      "reason",
    ],
    `fixture ${index}`,
  );
  const formatExpectationByPython = parseFormatOverrides(
    value.formatExpectationByPython,
    `fixture ${index}.formatExpectationByPython`,
  );
  const base = {
    id: requireString(value.id, `fixture ${index}.id`),
    detectionExpected: requireBoolean(
      value.detectionExpected,
      `fixture ${index}.detectionExpected`,
    ),
    formatExpectation: requireEnum(
      value.formatExpectation,
      FORMAT_EXPECTATIONS,
      `fixture ${index}.formatExpectation`,
    ),
    ...(formatExpectationByPython === undefined ? {} : { formatExpectationByPython }),
    grammarExpectation: requireEnum(
      value.grammarExpectation,
      GRAMMAR_EXPECTATIONS,
      `fixture ${index}.grammarExpectation`,
    ),
    reason: requireString(value.reason, `fixture ${index}.reason`),
  };
  if (kind === "content") {
    return {
      ...base,
      kind,
      content: requireString(value.content, `fixture ${index}.content`),
    };
  }
  return {
    ...base,
    kind,
    source: requireString(value.source, `fixture ${index}.source`),
  };
}

export function loadDetectionFixtures(): readonly DetectionFixture[] {
  const parsed = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Detection fixture must contain an array");
  }
  const fixtures = parsed.map(parseDetectionFixture);
  const ids = new Set<string>();
  for (const fixture of fixtures) {
    if (ids.has(fixture.id)) {
      throw new Error(`Duplicate detection fixture id: ${fixture.id}`);
    }
    ids.add(fixture.id);
  }
  return fixtures;
}
