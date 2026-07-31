import * as vscode from "vscode";

export const TOKEN_TYPES = [
  "inlineSqlKeyword",
  "inlineSqlString",
  "inlineSqlNumber",
  "inlineSqlOperator",
  "inlineSqlComment",
  "inlineSqlIdentifier",
] as const;

export type SemanticTokenType = (typeof TOKEN_TYPES)[number];

export function createSemanticTokensLegend(): vscode.SemanticTokensLegend {
  return new vscode.SemanticTokensLegend([...TOKEN_TYPES]);
}

export interface SqlExpressionSpan {
  readonly start: number;
  readonly end: number;
}

export interface SqlLiteralSpan {
  readonly start: number;
  readonly end: number;
  readonly expressions: readonly SqlExpressionSpan[];
}

export interface SqlSemanticToken {
  readonly start: number;
  readonly length: number;
  readonly type: SemanticTokenType;
}

const SQL_START_KEYWORDS = [
  "select",
  "with",
  "insert",
  "update",
  "delete",
  "merge",
  "create",
  "alter",
  "drop",
  "truncate",
  "explain",
] as const;

const SQL_MARKERS = new Set(["-- sql", "--sql"]);

const LITERAL_BEGIN_PATTERN =
  /(?<![A-Za-z0-9_])(rf|rF|Rf|RF|fr|fR|Fr|FR|r|R|f|F)?("""|'''|"(?!")|'(?!'))/g;

function isIdentifierContinue(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

function isFStringPrefix(prefix: string | undefined): boolean {
  return prefix !== undefined && /[fF]/.test(prefix);
}

function findLiteralEnd(text: string, contentStart: number, quote: string): number {
  if (quote.length === 3) {
    const end = text.indexOf(quote, contentStart);
    return end === -1 ? text.length : end;
  }
  for (let i = contentStart; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return text.length;
}

function detectSqlInLiteral(content: string): boolean {
  let lineStart = 0;
  while (lineStart < content.length) {
    const lineEnd = content.indexOf("\n", lineStart);
    const line = lineEnd === -1 ? content.slice(lineStart) : content.slice(lineStart, lineEnd);
    const trimmed = line.trim();
    if (trimmed !== "") {
      if (SQL_MARKERS.has(trimmed.toLowerCase())) return true;
      break;
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  const significant = content.search(/\S/);
  if (significant === -1) return false;
  const rest = content.slice(significant);
  const folded = rest.toLowerCase();
  for (const keyword of SQL_START_KEYWORDS) {
    if (!folded.startsWith(keyword)) continue;
    if (!isIdentifierContinue(rest[keyword.length])) return true;
  }
  return false;
}

function findExpressionRanges(content: string): readonly SqlExpressionSpan[] {
  const ranges: SqlExpressionSpan[] = [];
  let depth = 0;
  let expressionStart = -1;
  for (let i = 0; i < content.length; i += 1) {
    const character = content[i];
    if (depth === 0) {
      if (character === "{" && content[i + 1] !== "{") {
        depth = 1;
        expressionStart = i;
      } else if (character === "{") {
        i += 1;
      }
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) ranges.push({ start: expressionStart, end: i + 1 });
    }
  }
  return ranges;
}

export function findSqlLiterals(text: string): readonly SqlLiteralSpan[] {
  const literals: SqlLiteralSpan[] = [];
  LITERAL_BEGIN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LITERAL_BEGIN_PATTERN.exec(text)) !== null) {
    const prefix = match[1];
    const quote = match[2];
    if (quote === undefined) continue;
    const contentStart = match.index + (prefix?.length ?? 0) + quote.length;
    const contentEnd = findLiteralEnd(text, contentStart, quote);
    const content = text.slice(contentStart, contentEnd);
    if (!detectSqlInLiteral(content)) continue;
    const expressions = isFStringPrefix(prefix) ? findExpressionRanges(content) : [];
    literals.push({ start: contentStart, end: contentEnd, expressions });
  }
  return literals;
}

const SQL_KEYWORDS = new Set([
  "add",
  "all",
  "alter",
  "and",
  "any",
  "as",
  "asc",
  "between",
  "by",
  "case",
  "check",
  "column",
  "constraint",
  "create",
  "cross",
  "database",
  "default",
  "delete",
  "desc",
  "distinct",
  "drop",
  "else",
  "end",
  "except",
  "exists",
  "explain",
  "false",
  "fetch",
  "for",
  "foreign",
  "from",
  "full",
  "grant",
  "group",
  "having",
  "ilike",
  "in",
  "index",
  "inner",
  "insert",
  "intersect",
  "into",
  "is",
  "join",
  "key",
  "left",
  "like",
  "limit",
  "merge",
  "natural",
  "not",
  "null",
  "offset",
  "on",
  "or",
  "order",
  "outer",
  "over",
  "partition",
  "primary",
  "references",
  "regexp",
  "right",
  "rows",
  "select",
  "set",
  "table",
  "then",
  "top",
  "truncate",
  "true",
  "union",
  "unique",
  "update",
  "using",
  "values",
  "view",
  "when",
  "where",
  "window",
  "with",
]);

const SQL_TOKEN_PATTERN =
  /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])*"|`(?:\\.|[^`\\])*`|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|[<>!=+\-*/%,.;:(){}]+|\[|\]/g;

function isInsideExpression(expressions: readonly SqlExpressionSpan[], offset: number): boolean {
  for (const expression of expressions) {
    if (offset >= expression.start && offset < expression.end) return true;
  }
  return false;
}

function classifySqlToken(tokenText: string): SemanticTokenType {
  if (tokenText.startsWith("--") || tokenText.startsWith("/*")) return "inlineSqlComment";
  if (tokenText.startsWith("'") || tokenText.startsWith('"') || tokenText.startsWith("`"))
    return "inlineSqlString";
  if (/^\d/.test(tokenText)) return "inlineSqlNumber";
  if (/^[A-Za-z_]/.test(tokenText)) {
    return SQL_KEYWORDS.has(tokenText.toLowerCase()) ? "inlineSqlKeyword" : "inlineSqlIdentifier";
  }
  return "inlineSqlOperator";
}

export function tokenizeSqlLiteral(
  literal: SqlLiteralSpan,
  source: string,
): readonly SqlSemanticToken[] {
  if (literal.start >= literal.end) return [];
  const text = source.slice(literal.start, literal.end);
  const tokens: SqlSemanticToken[] = [];
  SQL_TOKEN_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(SQL_TOKEN_PATTERN)) {
    const offset = match.index;
    if (isInsideExpression(literal.expressions, offset)) continue;
    const tokenText = match[0];
    tokens.push({
      start: literal.start + offset,
      length: tokenText.length,
      type: classifySqlToken(tokenText),
    });
  }
  return tokens;
}

export const MAX_SEMANTIC_DOCUMENT_CHARS = 1_000_000;

function computeLineStarts(text: string): readonly number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function offsetToPosition(offset: number, lineStarts: readonly number[]): vscode.Position {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  const lineStart = lineStarts[low] ?? 0;
  return new vscode.Position(low, offset - lineStart);
}

function isCancellationRequested(token: vscode.CancellationToken): boolean {
  return token.isCancellationRequested;
}

export function createInlineSqlSemanticTokensProvider(): {
  readonly provider: vscode.DocumentSemanticTokensProvider;
  readonly legend: vscode.SemanticTokensLegend;
} {
  const legend = createSemanticTokensLegend();
  const provider: vscode.DocumentSemanticTokensProvider = {
    provideDocumentSemanticTokens(
      document: vscode.TextDocument,
      token: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.SemanticTokens> {
      const text = document.getText();
      if (text.length > MAX_SEMANTIC_DOCUMENT_CHARS || isCancellationRequested(token)) {
        return null;
      }
      const literals = findSqlLiterals(text);
      if (literals.length === 0) return null;
      const lineStarts = computeLineStarts(text);
      const builder = new vscode.SemanticTokensBuilder(legend);
      for (const literal of literals) {
        for (const sqlToken of tokenizeSqlLiteral(literal, text)) {
          if (isCancellationRequested(token)) return null;
          const start = offsetToPosition(sqlToken.start, lineStarts);
          const end = offsetToPosition(sqlToken.start + sqlToken.length, lineStarts);
          builder.push(new vscode.Range(start, end), sqlToken.type, []);
        }
      }
      return builder.build();
    },
  };
  return { provider, legend };
}
