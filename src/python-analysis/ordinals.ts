/** Replace GROUP BY / ORDER BY ordinal numbers with column names. */

interface SqlToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly depth: number;
}

interface SelectColumn {
  readonly expressionStart: number;
  readonly expressionEnd: number;
  readonly alias: string | undefined;
  readonly aggregate: boolean;
}

interface Clause {
  readonly itemRanges: readonly (readonly [number, number])[];
}

interface PendingScope {
  readonly depth: number;
  readonly columns: SelectColumn[];
  phase: "select" | "from";
  columnStart: number;
  activeClause: "group" | "order" | undefined;
  groupBy: Clause | undefined;
  orderBy: Clause | undefined;
  itemStart: number;
  itemRanges: [number, number][];
}

const TOKEN_PATTERN =
  /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])*"|`(?:\\.|[^`\\])*`|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|,|;|\(|\)|\.|\[|\]|\{|\}|[<>!=+\-*/%:|&^~]+/g;

const AGGREGATE_FUNCTIONS = new Set([
  "any_value",
  "array_agg",
  "avg",
  "bit_and",
  "bit_or",
  "bool_and",
  "bool_or",
  "count",
  "every",
  "group_concat",
  "json_agg",
  "max",
  "min",
  "string_agg",
  "sum",
  "xmlagg",
]);

/** Directional / position suffixes allowed after an ordinal in ORDER BY / GROUP BY items. */
const ORDINAL_SUFFIXES = new Set(["asc", "desc", "nulls", "first", "last"]);

/** Keywords that can never be a column alias inside a select list. */
const RESERVED = new Set([
  "as",
  "case",
  "else",
  "end",
  "from",
  "group",
  "having",
  "into",
  "join",
  "left",
  "limit",
  "offset",
  "on",
  "order",
  "right",
  "then",
  "union",
  "when",
  "where",
]);

function tokenize(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  let depth = 0;
  while ((match = TOKEN_PATTERN.exec(sql)) !== null) {
    if (match[0] === "{") {
      let end = match.index + 1;
      let braceDepth = 1;
      while (end < sql.length && braceDepth > 0) {
        if (sql[end] === "{") {
          braceDepth += 1;
        } else if (sql[end] === "}") {
          braceDepth -= 1;
        }
        end += 1;
      }
      tokens.push({ text: sql.slice(match.index, end), start: match.index, end, depth });
      TOKEN_PATTERN.lastIndex = end;
      continue;
    }
    const text = match[0];
    tokens.push({ text, start: match.index, end: match.index + text.length, depth });
    if (text === "(") {
      depth += 1;
    } else if (text === ")") {
      depth -= 1;
    }
  }
  return tokens;
}

function isKeyword(token: SqlToken, ...words: readonly string[]): boolean {
  const lower = token.text.toLowerCase();
  return words.some((word) => lower === word);
}

function isNumberToken(token: SqlToken): boolean {
  return /^\d/.test(token.text);
}

function isNameToken(token: SqlToken): boolean {
  return /^[A-Za-z_]/.test(token.text) && !/^\d/.test(token.text);
}

function isSelectStart(tokens: readonly SqlToken[], index: number): boolean {
  if (index === 0) return true;
  const previous = tokens[index - 1];
  const text = previous?.text.toLowerCase() ?? "";
  if (text === "all") {
    const before = tokens[index - 2]?.text.toLowerCase() ?? "";
    return before === "union" || before === "except";
  }
  return (
    text === "(" ||
    text === ";" ||
    text === ")" ||
    text === "union" ||
    text === "except" ||
    text === "intersect" ||
    text.startsWith("--") ||
    text.startsWith("{")
  );
}

function isOperator(token: SqlToken | undefined): boolean {
  return token !== undefined && /^[+\-*/%<>=!~|&^]+$/.test(token.text);
}

function isCommentToken(token: SqlToken): boolean {
  return token.text.startsWith("--") || token.text.startsWith("/*");
}

/** Extract alias and aggregate flag from one select-list item. */
function columnOf(tokens: readonly SqlToken[], start: number, end: number): SelectColumn {
  const visible = tokens.slice(start, end).filter((token) => !isCommentToken(token));
  const first = visible[0];
  const last = visible[visible.length - 1];
  if (first === undefined || last === undefined) {
    return { expressionStart: 0, expressionEnd: 0, alias: undefined, aggregate: false };
  }
  const secondLast = visible[visible.length - 2];
  const simpleColumn =
    visible.length % 2 === 1 &&
    visible.every((token, i) => (i % 2 === 0 ? isNameToken(token) : token.text === "."));
  let alias: string | undefined;
  let expressionEnd = last.end;
  if (
    secondLast !== undefined &&
    isKeyword(secondLast, "as") &&
    (isNameToken(last) || /^["`]/.test(last.text))
  ) {
    alias = last.text;
    expressionEnd = secondLast.start;
  } else if (
    secondLast !== undefined &&
    isNameToken(last) &&
    !RESERVED.has(last.text.toLowerCase()) &&
    !simpleColumn &&
    !isOperator(secondLast)
  ) {
    alias = last.text;
    expressionEnd = last.start;
  }
  const aggregate = AGGREGATE_FUNCTIONS.has(first.text.toLowerCase()) || first.text === "*";
  return {
    expressionStart: first.start,
    expressionEnd,
    alias,
    aggregate,
  };
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Copy a select expression without comments, preserving original spacing. */
function expressionText(sql: string, tokens: readonly SqlToken[], column: SelectColumn): string {
  let result = "";
  let cursor = column.expressionStart;
  for (const token of tokens) {
    if (token.start < column.expressionStart || token.end > column.expressionEnd) continue;
    if (!isCommentToken(token)) continue;
    result += sql.slice(cursor, token.start);
    cursor = token.end;
  }
  result += sql.slice(cursor, column.expressionEnd);
  return flatten(result);
}

/**
 * Replace `GROUP BY 1, 2` and `ORDER BY 1` ordinals with the corresponding
 * select-list column (its alias when present, otherwise its expression).
 * Unresolvable ordinals and aggregate expressions without an alias are left
 * untouched.
 */
export function replaceOrdinals(sql: string): string {
  const tokens = tokenize(sql);
  const scopes: PendingScope[] = [];
  const replacements: { readonly start: number; readonly end: number; readonly text: string }[] =
    [];

  const newScope = (depth: number, columnStart: number): PendingScope => ({
    depth,
    columns: [],
    phase: "select",
    columnStart,
    activeClause: undefined,
    groupBy: undefined,
    orderBy: undefined,
    itemStart: 0,
    itemRanges: [],
  });

  const closeClause = (scope: PendingScope, end: number): void => {
    if (scope.activeClause === undefined) return;
    const itemRanges = [...scope.itemRanges, [scope.itemStart, end] as const];
    const clause: Clause = { itemRanges };
    if (scope.activeClause === "group") {
      scope.groupBy = clause;
    } else {
      scope.orderBy = clause;
    }
    scope.activeClause = undefined;
  };

  const finishScope = (scope: PendingScope, endIndex: number): void => {
    closeClause(scope, endIndex);
    for (const clause of [scope.groupBy, scope.orderBy]) {
      if (clause === undefined) continue;
      for (const [start, end] of clause.itemRanges) {
        const itemTokens = tokens.slice(start, end);
        let ordinalToken: SqlToken | undefined;
        const firstItemToken = itemTokens[0];
        if (
          firstItemToken !== undefined &&
          isNumberToken(firstItemToken) &&
          itemTokens
            .slice(1)
            .every(
              (token) =>
                ORDINAL_SUFFIXES.has(token.text.toLowerCase()) ||
                token.text.startsWith("{") ||
                isCommentToken(token),
            )
        ) {
          ordinalToken = firstItemToken;
        }
        if (ordinalToken === undefined || !isNumberToken(ordinalToken)) continue;
        const ordinal = Number.parseInt(ordinalToken.text, 10);
        const column = scope.columns[ordinal - 1];
        if (column === undefined) continue;
        let text: string | undefined;
        if (column.alias !== undefined) {
          text = column.alias;
        } else if (!column.aggregate) {
          const expression = expressionText(sql, tokens, column);
          // ponytail: copying an expression that contains an f-string field or
          // a %-placeholder would duplicate it; keep the ordinal.
          if (!expression.includes("{") && !expression.includes("%")) text = expression;
        }
        if (text === undefined || text.length === 0) continue;
        replacements.push({ start: ordinalToken.start, end: ordinalToken.end, text });
      }
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    while (scopes.length > 0) {
      const top = scopes[scopes.length - 1];
      if (top === undefined || token.depth >= top.depth) break;
      finishScope(top, index);
      scopes.pop();
    }
    if (isKeyword(token, "select") && isSelectStart(tokens, index)) {
      const top = scopes[scopes.length - 1];
      if (top !== undefined && token.depth === top.depth) {
        finishScope(top, index);
        scopes.pop();
      }
      scopes.push(newScope(token.depth, index + 1));
      continue;
    }
    const scope = scopes[scopes.length - 1];
    if (scope === undefined || token.depth !== scope.depth) continue;
    if (scope.phase === "select") {
      if (isKeyword(token, "from")) {
        if (scope.columnStart < index) {
          scope.columns.push(columnOf(tokens, scope.columnStart, index));
        }
        scope.phase = "from";
      } else if (token.text === ",") {
        if (scope.columnStart < index) {
          scope.columns.push(columnOf(tokens, scope.columnStart, index));
        }
        scope.columnStart = index + 1;
      }
      continue;
    }
    if (token.text === ";") {
      finishScope(scope, index);
      scopes.pop();
      continue;
    }
    if (scope.activeClause !== undefined) {
      if (token.text === ",") {
        scope.itemRanges.push([scope.itemStart, index]);
        scope.itemStart = index + 1;
        continue;
      }
      if (
        token.text === ")" ||
        isKeyword(
          token,
          "having",
          "order",
          "limit",
          "offset",
          "qualify",
          "union",
          "except",
          "intersect",
          "distribute",
          "with",
        )
      ) {
        closeClause(scope, index);
      }
    }
    if (isKeyword(token, "group") && isKeyword(tokens[index + 1] ?? token, "by")) {
      scope.activeClause = "group";
      scope.itemStart = index + 2;
      scope.itemRanges = [];
    } else if (isKeyword(token, "order") && isKeyword(tokens[index + 1] ?? token, "by")) {
      scope.activeClause = "order";
      scope.itemStart = index + 2;
      scope.itemRanges = [];
    }
  }
  while (scopes.length > 0) {
    const scope = scopes.pop();
    if (scope !== undefined) finishScope(scope, tokens.length);
  }

  let result = sql;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  return result;
}
