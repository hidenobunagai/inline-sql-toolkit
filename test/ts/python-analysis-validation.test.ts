import { describe, expect, it } from "vitest";

import type { FormatOptions } from "../../src/protocol.js";
import { formatProtectedSql } from "../../src/vscode/sql-formatter.js";
import { detectSql, type SqlDetection } from "../../src/python-analysis/detection.js";
import { analyzeDocument, type DocumentAnalysis } from "../../src/python-analysis/literals.js";
import {
  formatCandidate,
  type SqlFormatter,
} from "../../src/python-analysis/validation.js";
import type { SupportedLiteral } from "../../src/python-analysis/tokenizer.js";

const NONCE = "abcdef0123456789abcdef0123456789";
const OPTIONS: FormatOptions = {
  keywordCase: "upper",
  indentWidth: 2,
  wrapAfter: 88,
  useSpaceAroundOperators: true,
  expandSelectList: true,
  trimBlankBoundaries: true,
  dialect: "postgresql",
};
const formatter: SqlFormatter = (sql, { options }) => formatProtectedSql(sql, options);

function analyzeOne(
  source: string,
): { analysis: DocumentAnalysis; literal: SupportedLiteral; detection: SqlDetection } {
  const analysis = analyzeDocument(source);
  const literal = analysis.supported[0];
  if (literal === undefined) throw new Error("no supported literal");
  const detection = detectSql(literal, analysis.sourceMap);
  return { analysis, literal, detection };
}

describe("formatCandidate", () => {
  it("edits a plain string to upper-case", () => {
    const source = 'query = "select 1"';
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(
      source,
      analysis,
      literal,
      detection,
      OPTIONS,
      NONCE,
      formatter,
    );
    expect(result).toEqual({
      sourceSpan: literal.span,
      expectedText: '"select 1"',
      replacementText: '"SELECT\n  1"',
    });
  });

  it("returns unchanged for already formatted SQL", () => {
    const source = 'query = """SELECT\n  1"""';
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(
      source,
      analysis,
      literal,
      detection,
      OPTIONS,
      NONCE,
      formatter,
    );
    expect(result).toEqual({ sourceSpan: literal.span });
  });

  it("keeps f-string fields intact", () => {
    const source = 'query = f"select {col} from users"';
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(
      source,
      analysis,
      literal,
      detection,
      OPTIONS,
      NONCE,
      formatter,
    );
    if ("replacementText" in result) {
      expect(result.replacementText).toContain("{col}");
      expect(result.replacementText).toContain('f"');
    }
    expect(result).not.toEqual({ sourceSpan: literal.span, reason: "FORMATTER_FAILED" });
  });

  it("skips non-SQL candidates", () => {
    const source = 'query = "not sql"';
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(
      source,
      analysis,
      literal,
      detection,
      OPTIONS,
      NONCE,
      formatter,
    );
    expect(result).toEqual({ sourceSpan: literal.span, reason: "NO_SQL_CANDIDATE" });
  });

  it("preserves the sql marker comment", () => {
    const source = 'query = """-- sql\nselect 1"""';
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(
      source,
      analysis,
      literal,
      detection,
      OPTIONS,
      NONCE,
      formatter,
    );
    if ("replacementText" in result) {
      expect(result.replacementText).toContain("-- sql\nSELECT\n  1");
    }
    expect(result).not.toEqual({ sourceSpan: literal.span, reason: "FORMATTER_FAILED" });
  });

  it("rejects a stale source snapshot", () => {
    const { analysis, literal, detection } = analyzeOne('query = "select 1"');
    const result = formatCandidate(
      'query = "changed"',
      analysis,
      literal,
      detection,
      OPTIONS,
      NONCE,
      formatter,
    );
    expect(result).toEqual({ sourceSpan: literal.span, reason: "FORMATTER_FAILED" });
  });
});
