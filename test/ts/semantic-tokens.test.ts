import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";

import {
  createInlineSqlSemanticTokensProvider,
  findSqlLiterals,
  type SqlLiteralSpan,
  tokenizeSqlLiteral,
} from "../../src/vscode/semantic-tokens.js";
import { __mock, type MockSemanticToken } from "../support/vscode-mock.js";

beforeEach(() => {
  __mock.reset();
});

function singleLiteral(source: string): SqlLiteralSpan {
  const literals = findSqlLiterals(source);
  const literal = literals[0];
  if (literal === undefined) throw new Error("expected exactly one SQL literal");
  return literal;
}

function sqlTokensForSource(source: string): readonly { text: string; type: string }[] {
  return tokensForSource(source).filter((token) => token.type.startsWith("inlineSql"));
}

function tokensForSource(source: string): readonly { text: string; type: string }[] {
  const document = __mock.document({
    uri: "file:///query.py",
    languageId: "python",
    text: source,
  });
  const { provider } = createInlineSqlSemanticTokensProvider();
  const token = new vscode.CancellationTokenSource().token;
  const semantic = provider.provideDocumentSemanticTokens(document, token);
  if (semantic === null || semantic === undefined) {
    throw new Error("expected semantic tokens to be provided");
  }
  const tokens = (semantic as unknown as { readonly tokens: readonly MockSemanticToken[] }).tokens;
  return tokens.map((item) => ({
    text: source.slice(item.range.start.character, item.range.end.character),
    type: item.tokenType,
  }));
}

describe("findSqlLiterals", () => {
  it("detects an f-string starting with a keyword", () => {
    const source = 'query = f"SELECT id, name FROM users"';
    const literal = singleLiteral(source);
    expect(source.slice(literal.start, literal.end)).toBe("SELECT id, name FROM users");
    expect(literal.expressions).toEqual([]);
  });

  it("detects a plain string starting with a keyword", () => {
    const source = 'query = "SELECT 1"';
    const literal = singleLiteral(source);
    expect(source.slice(literal.start, literal.end)).toBe("SELECT 1");
  });

  it("detects a keyword in any case", () => {
    const source = 'query = "select 1"';
    expect(findSqlLiterals(source)).toHaveLength(1);
  });

  it("detects a triple-quoted literal across lines", () => {
    const source = 'query = """\n  SELECT 1\n"""';
    const literal = singleLiteral(source);
    expect(source.slice(literal.start, literal.end)).toBe("\n  SELECT 1\n");
  });

  it("detects a marker comment literal", () => {
    const source = 'query = """-- sql\nSELECT 1"""';
    const literal = singleLiteral(source);
    expect(source.slice(literal.start, literal.end)).toBe("-- sql\nSELECT 1");
  });

  it("detects an rf-string and marks expression ranges", () => {
    const source = 'query = rf"SELECT {column} FROM users"';
    const literal = singleLiteral(source);
    expect(source.slice(literal.start, literal.end)).toBe("SELECT {column} FROM users");
    expect(literal.expressions).toEqual([{ start: 7, end: 15 }]);
  });

  it("treats escaped braces as plain SQL text", () => {
    const source = 'query = f"SELECT {{1}} AS one"';
    const literal = singleLiteral(source);
    expect(literal.expressions).toEqual([]);
  });

  it("ignores non-SQL strings", () => {
    expect(findSqlLiterals('greeting = "hello"')).toEqual([]);
    expect(findSqlLiterals('x = "selected"')).toEqual([]);
    expect(findSqlLiterals('x = "selecting"')).toEqual([]);
    expect(findSqlLiterals("x = 42")).toEqual([]);
  });

  it("respects escaped quotes inside the literal", () => {
    const source = String.raw`x = "SELECT 'a' FROM t"`;
    const literal = singleLiteral(source);
    expect(source.slice(literal.start, literal.end)).toBe("SELECT 'a' FROM t");
  });

  it("does not treat a comment after a literal as SQL", () => {
    const source = 'x = "SELECT 1" # select more';
    const literal = singleLiteral(source);
    expect(source.slice(literal.start, literal.end)).toBe("SELECT 1");
  });

  it("detects multiple literals in one document", () => {
    const source = 'a = "SELECT 1"\nb = f"WITH x AS (SELECT 1) SELECT * FROM x"';
    expect(findSqlLiterals(source)).toHaveLength(2);
  });

  it("does not match a string continuation of an identifier", () => {
    const source = 'x = f"{obj}"\nvalue = "not sql"';
    expect(findSqlLiterals(source)).toEqual([]);
  });
});

describe("tokenizeSqlLiteral", () => {
  const tokenize = (source: string) => {
    const literal = singleLiteral(source);
    const tokens = tokenizeSqlLiteral(literal, source);
    return tokens.map((token) => ({
      text: source.slice(token.start, token.start + token.length),
      type: token.type,
    }));
  };

  it("classifies keywords, identifiers, and operators", () => {
    const tokens = tokenize('query = f"SELECT id, name FROM users"');
    expect(tokens).toEqual([
      { text: "SELECT", type: "inlineSqlKeyword" },
      { text: "id", type: "inlineSqlIdentifier" },
      { text: ",", type: "inlineSqlOperator" },
      { text: "name", type: "inlineSqlIdentifier" },
      { text: "FROM", type: "inlineSqlKeyword" },
      { text: "users", type: "inlineSqlIdentifier" },
    ]);
  });

  it("classifies strings and numbers", () => {
    const tokens = tokenize("query = f\"SELECT 1, 'text' FROM t WHERE x = 2.5\"");
    expect(tokens).toEqual([
      { text: "SELECT", type: "inlineSqlKeyword" },
      { text: "1", type: "inlineSqlNumber" },
      { text: ",", type: "inlineSqlOperator" },
      { text: "'text'", type: "inlineSqlString" },
      { text: "FROM", type: "inlineSqlKeyword" },
      { text: "t", type: "inlineSqlIdentifier" },
      { text: "WHERE", type: "inlineSqlKeyword" },
      { text: "x", type: "inlineSqlIdentifier" },
      { text: "=", type: "inlineSqlOperator" },
      { text: "2.5", type: "inlineSqlNumber" },
    ]);
  });

  it("classifies comments", () => {
    const tokens = tokenize('query = "SELECT 1 -- inline note"');
    expect(tokens.at(-1)).toEqual({
      text: "-- inline note",
      type: "inlineSqlComment",
    });
  });

  it("skips f-string expressions", () => {
    const source = 'query = f"SELECT {column} FROM {table_name}"';
    const literal = singleLiteral(source);
    const tokens = tokenizeSqlLiteral(literal, source);
    expect(tokens.map((token) => source.slice(token.start, token.start + token.length))).toEqual([
      "SELECT",
      "FROM",
    ]);
  });

  it("matches keywords case-insensitively", () => {
    const tokens = tokenize('query = "select 1"');
    expect(tokens[0]?.type).toBe("inlineSqlKeyword");
  });

  it("leaves plain identifiers as identifiers", () => {
    const tokens = tokenize('query = "SELECT selecting FROM selected"');
    expect(tokens.map((token) => token.text)).toEqual(["SELECT", "selecting", "FROM", "selected"]);
    expect(tokens.map((token) => token.type)).toEqual([
      "inlineSqlKeyword",
      "inlineSqlIdentifier",
      "inlineSqlKeyword",
      "inlineSqlIdentifier",
    ]);
  });
});

describe("semantic tokens provider", () => {
  it("provides SQL keyword and number tokens inside the literal", () => {
    const tokens = sqlTokensForSource('query = "SELECT 1"');
    expect(tokens).toEqual([
      { text: "SELECT", type: "inlineSqlKeyword" },
      { text: "1", type: "inlineSqlNumber" },
    ]);
  });

  it("provides no tokens for a non-SQL document", () => {
    expect(() => tokensForSource('greeting = "hello"')).toThrow(
      "expected semantic tokens to be provided",
    );
  });

  it("skips f-string expressions in the token stream", () => {
    const tokens = sqlTokensForSource('query = f"SELECT {column} FROM users"');
    expect(tokens.map((token) => token.text)).toEqual(["SELECT", "FROM", "users"]);
  });

  it("treats a raw sql document as one whole sql literal", () => {
    const document = __mock.document({
      uri: "vscode-notebook-cell:///query.sql#0",
      languageId: "sql",
      text: "SELECT user_id FROM transactions WHERE amount > 0",
    });
    const { provider } = createInlineSqlSemanticTokensProvider();
    const token = new vscode.CancellationTokenSource().token;
    const semantic = provider.provideDocumentSemanticTokens(document, token);
    if (semantic === null || semantic === undefined) {
      throw new Error("expected semantic tokens to be provided");
    }
    const tokens = (
      semantic as unknown as { readonly tokens: readonly MockSemanticToken[] }
    ).tokens;
    const types = tokens.map((item) => item.tokenType);
    expect(types).toContain("inlineSqlKeyword");
    expect(types).toContain("inlineSqlNumber");
    expect(types).toContain("inlineSqlIdentifier");
  });
});
