import { describe, expect, it } from "vitest";

import { lexSql } from "../../src/python-analysis/sql-lexer.js";

function kinds(text: string, dialect: Parameters<typeof lexSql>[1] = "postgresql"): string[] {
  return lexSql(text, dialect)
    .filter((token) => token.kind !== "space")
    .map((token) => `${token.kind}:${token.text}`);
}

describe("lexSql", () => {
  it("separates code, strings, identifiers, and comments", () => {
    expect(kinds("SELECT a, 'x y' AS \"Q\" -- note\nFROM t /* c */")).toEqual([
      "word:SELECT",
      "word:a",
      "symbol:,",
      "string:'x y'",
      "word:AS",
      'quoted:"Q"',
      "line_comment:-- note",
      "word:FROM",
      "word:t",
      "block_comment:/* c */",
    ]);
  });

  it("keeps doubled quotes inside one string", () => {
    expect(kinds("'it''s'")).toEqual(["string:'it''s'"]);
  });

  it("escapes with backslashes only for MySQL and PostgreSQL E-strings", () => {
    expect(kinds(String.raw`'a\' b'`, "postgresql")).toEqual([
      String.raw`string:'a\'`,
      "word:b",
      "string:'",
    ]);
    expect(kinds(String.raw`'a\' b'`, "mysql")).toEqual([String.raw`string:'a\' b'`]);
    expect(kinds(String.raw`E'a\' b'`, "postgresql")).toEqual([
      "word:E",
      String.raw`string:'a\' b'`,
    ]);
    expect(kinds(String.raw`WHERE'a\'`, "postgresql")).toEqual([
      "word:WHERE",
      String.raw`string:'a\'`,
    ]);
  });

  it("reads # as a comment only for MySQL", () => {
    expect(kinds("a #> b", "postgresql")).toEqual(["word:a", "symbol:#", "symbol:>", "word:b"]);
    expect(kinds("a # b", "mysql")).toEqual(["word:a", "line_comment:# b"]);
  });

  it("keeps a dollar-quoted body as one token", () => {
    expect(kinds("SELECT $f$ a -- b $f$, $1")).toEqual([
      "word:SELECT",
      "dollar:$f$ a -- b $f$",
      "symbol:,",
      "symbol:$",
      "number:1",
    ]);
  });

  it("runs an unterminated string or comment to the end", () => {
    expect(kinds("a 'open")).toEqual(["word:a", "string:'open"]);
    expect(kinds("a /* open")).toEqual(["word:a", "block_comment:/* open"]);
  });
});
