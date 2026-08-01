import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { FormatOptions } from "../../src/protocol.js";
import { formatProtectedSql } from "../../src/vscode/sql-formatter.js";

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/sql-formatter-golden.json",
);

interface GoldenCase {
  readonly id: string;
  readonly dialect: FormatOptions["dialect"];
  readonly sql: string;
  readonly options: Partial<FormatOptions>;
  readonly expected: string;
}

const DEFAULTS: FormatOptions = {
  keywordCase: "upper",
  indentWidth: 2,
  wrapAfter: 88,
  useSpaceAroundOperators: true,
  expandSelectList: true,
  trimBlankBoundaries: true,
  dialect: "postgresql",
};

const goldenCases = JSON.parse(readFileSync(fixturePath, "utf8")) as readonly GoldenCase[];

function fixtureOptions(fixture: GoldenCase): FormatOptions {
  return { ...DEFAULTS, dialect: fixture.dialect, ...fixture.options };
}

describe("sql-formatter golden fixtures", () => {
  for (const fixture of goldenCases) {
    it(`formats ${fixture.id}`, () => {
      expect(formatProtectedSql(fixture.sql, fixtureOptions(fixture))).toBe(fixture.expected);
    });
  }
});

describe("sql-formatter idempotency", () => {
  for (const fixture of goldenCases) {
    it(`is idempotent for ${fixture.id}`, () => {
      const once = formatProtectedSql(fixture.sql, fixtureOptions(fixture));
      expect(formatProtectedSql(once, fixtureOptions(fixture))).toBe(once);
    });
  }
});
