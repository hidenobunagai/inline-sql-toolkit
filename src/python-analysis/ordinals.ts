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
  /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])*"|`(?:\\.|[^`\\])*`|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|[<>!=+\-*/%,.;:(){}]+|\[|\]/g;

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
  return (
    text === "(" ||
    text === ";" ||
    text === ")" ||
    text === "union" ||
    text === "except" ||
    text === "intersect" ||
    text.startsWith("--")
  );
}

function isOperator(token: SqlToken | undefined): boolean {
  return token !== undefined && /^[+\-*/%<>=!~|&^]+$/.test(token.text);
}

/** Extract alias and aggregate flag from one select-list item. */
function columnOf(tokens: readonly SqlToken[], start: number, end: number): SelectColumn {
  const slice = tokens.slice(start, end);
  const first = slice[0];
  const last = slice[slice.length - 1];
  if (first === undefined || last === undefined) {
    return { expressionStart: 0, expressionEnd: 0, alias: undefined, aggregate: false };
  }
  const secondLast = slice[slice.length - 2];
  const simpleColumn = slice.length === 1 || (slice.length === 3 && slice[1]?.text === ".");
  let alias: string | undefined;
  let expressionEnd = last.end;
  if (secondLast !== undefined && isKeyword(secondLast, "as") && isNameToken(last)) {
    alias = last.text;
    expressionEnd = secondLast.start;
  } else if (
    isNameToken(last) &&
    !RESERVED.has(last.text.toLowerCase()) &&
    !simpleColumn &&
    !isOperator(secondLast)
  ) {
    alias = last.text;
    expressionEnd = last.start;
  }
  const aggregate = AGGREGATE_FUNCTIONS.has(first.text.toLowerCase());
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
        const item = itemTokens[0];
        if (item === undefined || itemTokens.length !== 1 || !isNumberToken(item)) continue;
        const ordinal = Number.parseInt(item.text, 10);
        const column = scope.columns[ordinal - 1];
        if (column === undefined) continue;
        const text =
          column.alias ??
          (column.aggregate
            ? undefined
            : flatten(sql.slice(column.expressionStart, column.expressionEnd)));
        if (text === undefined || text.length === 0) continue;
        replacements.push({ start: item.start, end: item.end, text });
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
        isKeyword(token, "having", "order", "limit", "offset", "union", "except", "intersect")
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
