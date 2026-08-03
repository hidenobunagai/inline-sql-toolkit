import { describe, expect, it } from "vitest";

import type { FormatOptions, FormatTarget } from "../../src/protocol.js";
import {
  combinedSource,
  type DetectedUnit,
  discover,
  formatDocument,
  selectUnits,
} from "../../src/python-analysis/engine.js";
import { analyzeDocument } from "../../src/python-analysis/literals.js";
import { PositionMappingError, SourceMap } from "../../src/python-analysis/positions.js";
import type { SqlFormatter } from "../../src/python-analysis/validation.js";
import { formatProtectedSql } from "../../src/vscode/sql-formatter.js";

const NONCE = "abcdef0123456789abcdef0123456789";
const OPTIONS: FormatOptions = {
  keywordCase: "upper",
  indentWidth: 2,
  wrapAfter: 88,
  useSpaceAroundOperators: true,
  expandSelectList: true,
  trimBlankBoundaries: true,
  replaceOrdinals: true,
  dialect: "postgresql",
};
const formatter: SqlFormatter = (sql, { options }) => formatProtectedSql(sql, options);
const ALL: FormatTarget = { mode: "all" };

describe("discover", () => {
  it("finds SQL-looking literals only", () => {
    const analysis = analyzeDocument('a = "select 1"\nb = "not sql"');
    const units = discover(analysis);
    expect(units).toHaveLength(1);
  });
});

describe("selectUnits", () => {
  function unitsOf(source: string): { units: readonly DetectedUnit[]; map: SourceMap } {
    const analysis = analyzeDocument(source);
    return { units: discover(analysis), map: analysis.sourceMap };
  }

  it("selects the unit under the cursor", () => {
    const { units, map } = unitsOf('a = "select 1"\nb = "select 2"');
    const selected = selectUnits(units, { mode: "cursor", cursor: { line: 1, character: 5 } }, map);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.literal.span.start).toBeGreaterThan(10);
  });

  it("selects units intersecting a selection", () => {
    const { units, map } = unitsOf('a = "select 1"\nb = "select 2"');
    const selected = selectUnits(
      units,
      {
        mode: "selection",
        selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 14 } },
      },
      map,
    );
    expect(selected).toHaveLength(1);
  });

  it("rejects a reversed selection", () => {
    const { units, map } = unitsOf('a = "select 1"');
    expect(() =>
      selectUnits(
        units,
        {
          mode: "selection",
          selection: { start: { line: 1, character: 0 }, end: { line: 0, character: 0 } },
        },
        map,
      ),
    ).toThrow(PositionMappingError);
  });
});

describe("combinedSource", () => {
  it("applies edits from the end to the start", () => {
    const source = 'a = "select 1"\nb = "select 2"';
    const analysis = analyzeDocument(source);
    const first = analysis.supported[0];
    const second = analysis.supported[1];
    if (first === undefined || second === undefined) {
      throw new Error("expected two supported literals");
    }
    const combined = combinedSource(source, [
      { sourceSpan: first.span, expectedText: "x", replacementText: '"SELECT 1"' },
      { sourceSpan: second.span, expectedText: "y", replacementText: '"SELECT 2"' },
    ]);
    expect(combined).toBe('a = "SELECT 1"\nb = "SELECT 2"');
  });

  it("rejects overlapping edits", () => {
    expect(() =>
      combinedSource("abc", [
        { sourceSpan: { start: 0, end: 3 }, expectedText: "a", replacementText: "x" },
        { sourceSpan: { start: 1, end: 3 }, expectedText: "b", replacementText: "y" },
      ]),
    ).toThrow(Error);
  });
});

describe("formatDocument", () => {
  it("formats every selected SQL literal", () => {
    const source = 'a = "select 1"\nb = "select 2"';
    const result = formatDocument(source, OPTIONS, ALL, NONCE, formatter);
    expect(result.edits).toHaveLength(2);
    expect(result.summary).toMatchObject({ discovered: 2, selected: 2, changed: 2 });
    expect(combinedSource(source, result.edits)).toBe('a = "SELECT\n  1"\nb = "SELECT\n  2"');
  });

  it("skips unsupported literals", () => {
    const source = 'a = "select 1" "x"\nb = "select 2"';
    const result = formatDocument(source, OPTIONS, ALL, NONCE, formatter);
    expect(result.summary).toMatchObject({ discovered: 2, selected: 2, changed: 1, skipped: 1 });
  });

  it("respects the cursor target", () => {
    const source = 'a = "select 1"\nb = "select 2"';
    const result = formatDocument(
      source,
      OPTIONS,
      { mode: "cursor", cursor: { line: 0, character: 5 } },
      NONCE,
      formatter,
    );
    expect(result.edits).toHaveLength(1);
  });
});
