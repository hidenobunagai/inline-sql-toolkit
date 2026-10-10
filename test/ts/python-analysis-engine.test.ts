import { describe, expect, it } from "vitest";

import type { FormatOptions, FormatTarget } from "../../src/protocol.js";
import {
  combinedSource,
  type DetectedUnit,
  discover,
  formatDocument,
  preservesDocumentShape,
  selectUnits,
} from "../../src/python-analysis/engine.js";
import { analyzeDocument } from "../../src/python-analysis/literals.js";
import {
  PositionMappingError,
  SourceMap,
  SourceSpan,
} from "../../src/python-analysis/positions.js";
import type { SqlFormatter } from "../../src/python-analysis/validation.js";
import { formatProtectedSql } from "../../src/sql-formatter.js";

const NONCE = "abcdef0123456789abcdef0123456789";
const OPTIONS: FormatOptions = {
  keywordCase: "upper",
  indentWidth: 2,
  wrapAfter: 88,
  useSpaceAroundOperators: true,
  replaceOrdinals: true,
  dialect: "postgresql",
  commaPosition: "after",
  keepFunctionsInline: false,
};
const formatter: SqlFormatter = (sql, { options }) => formatProtectedSql(sql, options);
const ALL: FormatTarget = { mode: "all" };

describe("discover", () => {
  it("finds SQL-looking literals only", () => {
    const analysis = analyzeDocument('a = "select 1"\nb = "not sql"');
    const units = discover(analysis);
    expect(units).toHaveLength(1);
  });

  it("skips single-line literal with trailing skip pragma", () => {
    const analysis = analyzeDocument('q = "select a,b from t"  # inline-sql: skip');
    expect(discover(analysis)).toHaveLength(0);
  });

  it("skips triple-quoted literal with trailing pragma on closing quote line", () => {
    const code = [
      'q = """--sql',
      "select   a,",
      "         b",
      "from t",
      '"""  # inline-sql: skip',
    ].join("\n");
    const analysis = analyzeDocument(code);
    expect(discover(analysis)).toHaveLength(0);
  });

  it("skips literal when dedicated own-line pragma is immediately above", () => {
    const code = ["# inline-sql: skip", 'q = """--sql', "select 1", '"""'].join("\n");
    const analysis = analyzeDocument(code);
    expect(discover(analysis)).toHaveLength(0);
  });

  it("skips literal inside parentheses when dedicated pragma is 1 line above", () => {
    const code = ["query = (", "    # inline-sql: skip", '    """--sql select 1"""', ")"].join(
      "\n",
    );
    const analysis = analyzeDocument(code);
    expect(discover(analysis)).toHaveLength(0);
  });

  it("does not skip subsequent line literal when preceding statement has trailing pragma", () => {
    const code = ['a = "select 1"  # inline-sql: skip', 'b = "select 2"'].join("\n");
    const analysis = analyzeDocument(code);
    const units = discover(analysis);
    expect(units).toHaveLength(1);
    const firstUnit = units[0];
    if (firstUnit === undefined) throw new Error("expected unit");
    expect(analysis.sourceMap.slice(firstUnit.literal.span)).toBe('"select 2"');
  });

  it("does not skip when an empty line exists between own-line pragma and literal", () => {
    const code = ["# inline-sql: skip", "", 'q = "select 1"'].join("\n");
    const analysis = analyzeDocument(code);
    expect(discover(analysis)).toHaveLength(1);
  });

  it("skips when pragma is co-located with other pragmas and case varies", () => {
    const code = 'q = "select 1"  # noqa: E501  # INLINE-SQL: Skip';
    const analysis = analyzeDocument(code);
    expect(discover(analysis)).toHaveLength(0);
  });

  it("does not skip when pragma has word boundary suffixes like skip-file or skipped", () => {
    const code1 = 'q = "select 1"  # inline-sql: skip-file';
    expect(discover(analyzeDocument(code1))).toHaveLength(1);

    const code2 = 'q = "select 1"  # inline-sql: skipped';
    expect(discover(analyzeDocument(code2))).toHaveLength(1);
  });

  it("does not skip when pragma is inside string body", () => {
    const code = 'q = """--sql\nselect 1 # inline-sql: skip\n"""';
    expect(discover(analyzeDocument(code))).toHaveLength(1);
  });

  it("handles CRLF documents for pragma skipping identically", () => {
    const trailingCrlf = 'q = "select 1"  # inline-sql: skip\r\n';
    expect(discover(analyzeDocument(trailingCrlf))).toHaveLength(0);

    const ownLineCrlf = '# inline-sql: skip\r\nq = "select 1"\r\n';
    expect(discover(analyzeDocument(ownLineCrlf))).toHaveLength(0);
  });

  it("skips every literal on the pragma line, not just one", () => {
    const trailing = 'a, b = "select 1", "select 2"  # inline-sql: skip';
    expect(discover(analyzeDocument(trailing))).toHaveLength(0);

    const ownLine = ["# inline-sql: skip", 'a, b = "select 1", "select 2"'].join("\n");
    expect(discover(analyzeDocument(ownLine))).toHaveLength(0);
  });

  it("omits skipped literals from summary.discovered and skipReasons in formatDocument", () => {
    const code = ['q1 = "select 1"  # inline-sql: skip', 'q2 = "select 2"'].join("\n");
    const result = formatDocument(code, OPTIONS, ALL, NONCE, formatter);
    expect(result.summary.discovered).toBe(1);
    expect(result.summary.skipped).toBe(0);
    expect(result.skipReasons).toEqual([]);
    expect(result.summary.changed).toBe(1);
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

describe("preservesDocumentShape", () => {
  const source = 'a = "select 1"\nb = f"select {x}"\n';
  const analysis = analyzeDocument(source);
  const edit = (start: number, end: number, replacementText: string) => ({
    sourceSpan: new SourceSpan(start, end),
    expectedText: source.slice(start, end),
    replacementText,
  });

  it("accepts edits that keep every literal's place and shape", () => {
    expect(preservesDocumentShape(source, analysis, [edit(4, 14, '"SELECT 1"')])).toBe(true);
    expect(
      preservesDocumentShape(source, analysis, [
        edit(4, 14, '"SELECT\n 1"'),
        edit(19, 32, 'f"SELECT {x}"'),
      ]),
    ).toBe(true);
  });

  it("rejects edits that add, merge, or reshape literals", () => {
    expect(preservesDocumentShape(source, analysis, [edit(4, 14, '"SELECT 1" "x"')])).toBe(false);
    expect(preservesDocumentShape(source, analysis, [edit(4, 14, '"""SELECT 1')])).toBe(false);
    expect(preservesDocumentShape(source, analysis, [edit(4, 14, 'r"SELECT 1"')])).toBe(false);
  });
});

describe("formatDocument", () => {
  it("formats every selected SQL literal", () => {
    const source = 'a = "select 1"\nb = "select 2"';
    const result = formatDocument(source, OPTIONS, ALL, NONCE, formatter);
    expect(result.edits).toHaveLength(2);
    expect(result.summary).toMatchObject({ discovered: 2, selected: 2, changed: 2 });
    expect(combinedSource(source, result.edits)).toBe('a = "SELECT 1"\nb = "SELECT 2"');
  });

  it("leaves prose and bare keyword values that start with a SQL keyword untouched", () => {
    const source = [
      'label = "Update available"',
      'msg = "Select an option, then press OK"',
      'hint = "Drop files here"',
      'title = "Create a new account"',
      'confirm = "Delete this item? This cannot be undone."',
      'note = "With love, from the team"',
      'err = "Explain why"',
      'op = "update"',
      'mode = "create"',
      'kind = "select"',
      'msg2 = "update failed for user %s"',
    ].join("\n");
    const result = formatDocument(source, OPTIONS, ALL, NONCE, formatter);
    expect(result.summary.discovered).toBe(0);
    expect(result.edits).toEqual([]);
  });

  it.each([
    'query = (\n    "SELECT id FROM users "  # filter\n    "WHERE active"\n)',
    'query = "SELECT id FROM users " \\\n    "WHERE active"',
    'query = "SELECT id, name FROM " + table + " WHERE id = 1"',
  ])("never edits a concatenated SQL piece: %j", (source) => {
    const result = formatDocument(source, OPTIONS, ALL, NONCE, formatter);
    expect(result.edits).toEqual([]);
    expect(result.skipReasons).toContain("UNSUPPORTED_LITERAL");
  });

  it("formats nothing in a document with an unterminated string", () => {
    const source = 'def f():\n    """unterminated docstring\n    x = "SELECT a,b FROM t"\n';
    const result = formatDocument(source, OPTIONS, ALL, NONCE, formatter);
    expect(result.edits).toEqual([]);
    expect(result.skipReasons).toContain("UNSUPPORTED_LITERAL");
  });

  it("skips an f-string whose field reuses the f-string's quote", () => {
    const source = 'q = f"SELECT * FROM t WHERE id = {row["id"]} AND x = 1"';
    const result = formatDocument(source, OPTIONS, ALL, NONCE, formatter);
    expect(result.edits).toEqual([]);
    expect(result.skipReasons).toEqual(["UNSUPPORTED_LITERAL"]);
  });

  it("keeps the edge spaces of a single-line literal", () => {
    const source = 'head = "  select * from t "\nquery = head + tail';
    const result = formatDocument(source, OPTIONS, ALL, NONCE, formatter);
    expect(combinedSource(source, result.edits)).toBe(
      'head = "  SELECT * FROM t "\nquery = head + tail',
    );
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
