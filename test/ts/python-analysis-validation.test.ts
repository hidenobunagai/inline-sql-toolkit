import { describe, expect, it } from "vitest";

import type { FormatOptions } from "../../src/protocol.js";
import { detectSql, type SqlDetection } from "../../src/python-analysis/detection.js";
import { analyzeDocument, type DocumentAnalysis } from "../../src/python-analysis/literals.js";
import type { SupportedLiteral } from "../../src/python-analysis/tokenizer.js";
import { formatCandidate, type SqlFormatter } from "../../src/python-analysis/validation.js";
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

function analyzeOne(source: string): {
  analysis: DocumentAnalysis;
  literal: SupportedLiteral;
  detection: SqlDetection;
} {
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
    const result = formatCandidate(source, analysis, literal, detection, OPTIONS, NONCE, formatter);
    expect(result).toEqual({
      sourceSpan: literal.span,
      expectedText: '"select 1"',
      replacementText: '"SELECT\n  1"',
    });
  });

  it("returns unchanged for already formatted SQL", () => {
    const source = 'query = """\n  SELECT\n    1\n"""';
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(source, analysis, literal, detection, OPTIONS, NONCE, formatter);
    expect(result).toEqual({ sourceSpan: literal.span });
  });

  it("keeps f-string fields intact", () => {
    const source = 'query = f"select {col} from users"';
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(source, analysis, literal, detection, OPTIONS, NONCE, formatter);
    if ("replacementText" in result) {
      expect(result.replacementText).toContain("{col}");
      expect(result.replacementText).toContain('f"');
    }
    expect(result).not.toEqual({ sourceSpan: literal.span, reason: "FORMATTER_FAILED" });
  });

  it("skips non-SQL candidates", () => {
    const source = 'query = "not sql"';
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(source, analysis, literal, detection, OPTIONS, NONCE, formatter);
    expect(result).toEqual({ sourceSpan: literal.span, reason: "NO_SQL_CANDIDATE" });
  });

  it("preserves the sql marker comment", () => {
    const source = 'query = """-- sql\nselect 1"""';
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(source, analysis, literal, detection, OPTIONS, NONCE, formatter);
    if ("replacementText" in result) {
      expect(result.replacementText).toContain("-- sql\n  SELECT");
    }
    expect(result).not.toEqual({ sourceSpan: literal.span, reason: "FORMATTER_FAILED" });
  });

  it("normalizes triple-quoted frame boundaries", () => {
    const source = 'query = """SELECT\n  1"""';
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(source, analysis, literal, detection, OPTIONS, NONCE, formatter);
    if ("replacementText" in result) {
      expect(result.replacementText).toBe('"""\n  SELECT\n    1\n"""');
    } else {
      throw new Error("expected a changed candidate");
    }
  });

  it("preserves the base indent of an indented triple-quoted literal", () => {
    const source = 'q = """\n    --sql\n    select 1\n    """';
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(source, analysis, literal, detection, OPTIONS, NONCE, formatter);
    if ("replacementText" in result) {
      expect(result.replacementText).toBe('"""--sql\n  SELECT\n    1\n"""');
    } else {
      throw new Error("expected a changed candidate");
    }
  });

  it("keeps a marker adjacent to the opening quote on its own line", () => {
    const source = 'q = """--sql\nselect 1\n"""';
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(source, analysis, literal, detection, OPTIONS, NONCE, formatter);
    if ("replacementText" in result) {
      expect(result.replacementText).toBe('"""--sql\n  SELECT\n    1\n"""');
    } else {
      throw new Error("expected a changed candidate");
    }
  });

  it("replaces GROUP BY ordinals with the referenced column names", () => {
    const source =
      'query = """--sql\nSELECT user_id, date_trunc(\'month\', paid_at) AS ym FROM payments GROUP BY 1, 2\n"""';
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(source, analysis, literal, detection, OPTIONS, NONCE, formatter);
    if ("replacementText" in result) {
      expect(result.replacementText).toBe(
        '"""--sql\n  SELECT\n    user_id,\n    date_trunc(\'month\', paid_at) AS ym\n  FROM\n    payments\n  GROUP BY\n    user_id,\n    ym\n"""',
      );
    } else {
      throw new Error("expected a changed candidate");
    }
  });

  it("keeps ordinals when replaceOrdinals is disabled", () => {
    const source = 'query = """--sql\nSELECT user_id FROM payments GROUP BY 1\n"""';
    const { analysis, literal, detection } = analyzeOne(source);
    const disabled = { ...OPTIONS, replaceOrdinals: false };
    const result = formatCandidate(
      source,
      analysis,
      literal,
      detection,
      disabled,
      NONCE,
      formatter,
    );
    if ("replacementText" in result) {
      expect(result.replacementText).toBe(
        '"""--sql\n  SELECT\n    user_id\n  FROM\n    payments\n  GROUP BY\n    1\n"""',
      );
    } else {
      throw new Error("expected a changed candidate");
    }
  });

  it("replaces ordinals after a leading f-string field and breaks the trailing field", () => {
    const source = `query = f"""--sql
{write_clause}
SELECT
  a,
  b,
  c,
  d,
  e
FROM
  t
GROUP BY
  1,
  2,
  3,
  4,
  5 {distribution_clause}
"""`;
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(source, analysis, literal, detection, OPTIONS, NONCE, formatter);
    if ("replacementText" in result) {
      expect(result.replacementText).toBe(
        `f"""--sql
  {write_clause}
  SELECT
    a,
    b,
    c,
    d,
    e
  FROM
    t
  GROUP BY
    a,
    b,
    c,
    d,
    e
    {distribution_clause}
"""`,
      );
    } else {
      throw new Error("expected a changed candidate");
    }
  });

  it("breaks a trailing DISTRIBUTE clause onto its own line", () => {
    const source =
      'query = """--sql\nSELECT\n  a,\n  b,\n  c\nFROM\n  t\nGROUP BY\n  1,\n  2,\n  3 DISTRIBUTE RANDOM\n"""';
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(source, analysis, literal, detection, OPTIONS, NONCE, formatter);
    if ("replacementText" in result) {
      expect(result.replacementText).toBe(
        '"""--sql\n  SELECT\n    a,\n    b,\n    c\n  FROM\n    t\n  GROUP BY\n    a,\n    b,\n    c\n    DISTRIBUTE RANDOM\n"""',
      );
    } else {
      throw new Error("expected a changed candidate");
    }
  });

  it("moves a comma before a trailing line comment", () => {
    const source =
      'query = """--sql\nSELECT\n    order_id --テキスト\n,\n    order_date --テキスト\n,\n    amount\n"""';
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(source, analysis, literal, detection, OPTIONS, NONCE, formatter);
    if ("replacementText" in result) {
      expect(result.replacementText).toBe(
        '"""--sql\n  SELECT\n    order_id, --テキスト\n    order_date, --テキスト\n    amount\n"""',
      );
    } else {
      throw new Error("expected a changed candidate");
    }
  });

  it("formats f-string fields next to comments without duplicating the field", () => {
    const source =
      'query = f"""--sql\nSELECT ci.{parameter} /* テキスト */, amount FROM t GROUP BY 1, 2\n"""';
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(source, analysis, literal, detection, OPTIONS, NONCE, formatter);
    if ("replacementText" in result) {
      expect(result.replacementText).toBe(
        'f"""--sql\n  SELECT\n    ci.{parameter} /* テキスト */,\n    amount\n  FROM\n    t\n  GROUP BY\n    1,\n    amount\n"""',
      );
    } else {
      throw new Error("expected a changed candidate");
    }
  });

  it("converges CASE expressions to their stable layout", () => {
    const source =
      'query = """--sql\nSELECT chn /* テキスト */, nm /* テキスト */, CASE WHEN site = 1 THEN chn ELSE nm END AS label, amount FROM t GROUP BY 1, 2, 3, 4\n"""';
    const { analysis, literal, detection } = analyzeOne(source);
    const result = formatCandidate(source, analysis, literal, detection, OPTIONS, NONCE, formatter);
    if ("replacementText" in result) {
      expect(result.replacementText).toBe(
        '"""--sql\n  SELECT\n    chn /* テキスト */,\n    nm /* テキスト */,\n    CASE\n      WHEN site = 1 THEN chn\n      ELSE nm\n    END AS label,\n    amount\n  FROM\n    t\n  GROUP BY\n    chn,\n    nm,\n    label,\n    amount\n"""',
      );
    } else {
      throw new Error("expected a changed candidate");
    }
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

  it("logs skip details to the debug logger", () => {
    const lines: string[] = [];
    const logger = (message: string): void => {
      lines.push(message);
    };
    const stale = analyzeOne('query = "select 1"');
    formatCandidate(
      'query = "changed"',
      stale.analysis,
      stale.literal,
      stale.detection,
      OPTIONS,
      NONCE,
      formatter,
      logger,
    );
    expect(lines.some((line) => line.includes("FORMATTER_FAILED"))).toBe(true);
    expect(lines.some((line) => line.includes("stale source snapshot"))).toBe(true);

    const unparsable = analyzeOne('query = """--sql\nSELECT {col} FROM t\n"""');
    formatCandidate(
      'query = """--sql\nSELECT {col} FROM t\n"""',
      unparsable.analysis,
      unparsable.literal,
      unparsable.detection,
      OPTIONS,
      NONCE,
      formatter,
      logger,
    );
    expect(
      lines.some((line) => line.includes("FORMATTER_FAILED") && line.includes("literal:")),
    ).toBe(true);
  });
});
