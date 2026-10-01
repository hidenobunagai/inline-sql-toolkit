import { describe, expect, it } from "vitest";

import { detectSql } from "../../src/python-analysis/detection.js";
import { SourceMap } from "../../src/python-analysis/positions.js";
import {
  scanFstringFieldSpans,
  scanStringSurfaces,
  type SupportedLiteral,
} from "../../src/python-analysis/tokenizer.js";

function analyze(source: string): { literal: SupportedLiteral; map: SourceMap } {
  const map = SourceMap.fromText(source);
  const surface = scanStringSurfaces(source)[0];
  if (surface === undefined) throw new Error("missing literal surface");
  const fieldSpans = scanFstringFieldSpans(source, surface.contentSpan);
  const prefix = surface.prefix.toLowerCase();
  const kind =
    prefix === "f"
      ? "fstring"
      : prefix === "rf" || prefix === "fr"
        ? "raw_fstring"
        : prefix === "r"
          ? "raw"
          : "plain";
  return {
    literal: {
      span: surface.span,
      contentSpan: surface.contentSpan,
      prefix: surface.prefix,
      delimiter: surface.delimiter as SupportedLiteral["delimiter"],
      kind,
      fieldSpans,
    },
    map,
  };
}

describe("detectSql", () => {
  it.each([
    ['q = "select 1"', true, "keyword"],
    ['q = "SELECT 1"', true, "keyword"],
    ['q = "  select 1"', true, "keyword"],
    ['q = "with x as (select 1)"', true, "keyword"],
    ['q = "update users set a = 1"', true, "keyword"],
    ['q = "-- sql\nselect 1"', true, "marker"],
    ['q = "--sql\nselect 1"', true, "marker"],
    ['q = "  -- sql  \nselect 1"', true, "marker"],
    ['q = "selectx 1"', false, "none"],
    ['q = "not sql"', false, "none"],
    ['q = "  "', false, "none"],
    ['q = "the select"', false, "none"],
    ['q = "Select 1"', false, "none"],
    ['q = "sElEcT 1"', false, "none"],
    ['q = "select"', false, "none"],
    ['q = "select id"', false, "none"],
    ['q = "select id from users"', true, "keyword"],
    ['q = "SELECT *"', true, "keyword"],
    ['q = "select count(*) as n"', true, "keyword"],
    ['q = "select case when a then 1 end"', true, "keyword"],
    ['q = "WITH RECURSIVE t(n) AS (SELECT 1) SELECT n FROM t"', true, "keyword"],
    ['q = "insert or replace into t values (1)"', true, "keyword"],
    ['q = "INSERT IGNORE INTO t VALUES (1)"', true, "keyword"],
    ['q = "update public.users u set a = 1"', true, "keyword"],
    ['q = "UPDATE %s SET a = 1"', true, "keyword"],
    ['q = "update now"', false, "none"],
    ['q = "DELETE t FROM t JOIN u ON t.id = u.id"', true, "keyword"],
    ['q = "CREATE OR REPLACE TEMP VIEW v AS SELECT 1"', true, "keyword"],
    ['q = "CREATE UNIQUE INDEX i ON t (a)"', true, "keyword"],
    ['q = "create user failed"', false, "none"],
    ['q = "drop index if exists i"', true, "keyword"],
    ['q = "TRUNCATE t RESTART IDENTITY"', true, "keyword"],
    ['q = "EXPLAIN ANALYZE SELECT 1"', true, "keyword"],
    ['q = "EXPLAIN (FORMAT JSON) SELECT 1"', true, "keyword"],
    ['q = "select a\\nfrom t"', true, "keyword"],
  ] as const)("detects %j as %s", (source, matched, reason) => {
    const { literal, map } = analyze(source);
    const detection = detectSql(literal, map);
    expect(detection.matched).toBe(matched);
    expect(detection.reason).toBe(reason);
  });

  it("reports the marker span for marker detections", () => {
    const { literal, map } = analyze('q = """-- sql\nselect 1"""');
    const detection = detectSql(literal, map);
    expect(detection.markerSpan).toEqual({ start: 7, end: 13 });
    expect(detection.sqlSpan).toEqual({ start: 14, end: 22 });
  });

  it("reports the keyword span for keyword detections", () => {
    const { literal, map } = analyze('q = "  select 1"');
    const detection = detectSql(literal, map);
    expect(detection.markerSpan).toBeUndefined();
    expect(detection.sqlSpan).toEqual({ start: 7, end: 15 });
  });

  it("returns none for unsupported literals without a detection span", () => {
    const detection = detectSql(
      {
        span: { start: 0, end: 2 },
        detectionContentSpan: undefined,
        reason: "UNSUPPORTED_LITERAL",
      },
      SourceMap.fromText(""),
    );
    expect(detection).toEqual({
      matched: false,
      markerSpan: undefined,
      sqlSpan: undefined,
      reason: "none",
    });
  });
});
