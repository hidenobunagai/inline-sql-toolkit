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
  /** `*` or `t.*`: it expands to an unknown number of columns. */
  readonly star: boolean;
  /** Normalized output column name: the alias, or a simple column's last part. */
  readonly outputName: string | undefined;
  /** Normalized names referenced by the expression. */
  readonly names: readonly string[];
}

interface Clause {
  readonly itemRanges: readonly (readonly [number, number])[];
}

interface PendingScope {
  readonly depth: number;
  /** The SELECT follows UNION / EXCEPT / INTERSECT. */
  setOperand: boolean;
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

/** Calls whose copy would be evaluated again and yield a different value. */
const VOLATILE_FUNCTIONS = new Set([
  "clock_timestamp",
  "gen_random_uuid",
  "newid",
  "nextval",
  "rand",
  "random",
  "setval",
  "timeofday",
  "uuid",
  "uuid_generate_v1",
  "uuid_generate_v4",
]);

/** Modifiers between SELECT and the first select-list item. */
const SELECT_MODIFIERS = new Set([
  "all",
  "distinct",
  "distinctrow",
  "high_priority",
  "sql_big_result",
  "sql_buffer_result",
  "sql_calc_found_rows",
  "sql_no_cache",
  "sql_small_result",
  "straight_join",
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
    // An f-string field `{...}` or a bracket group `[...]` (array index or
    // SQLite identifier) is one opaque token: its commas separate nothing and
    // its spacing is copied verbatim.
    if (match[0] === "{" || match[0] === "[") {
      const open = match[0];
      const close = open === "{" ? "}" : "]";
      let end = match.index + 1;
      let nesting = 1;
      while (end < sql.length && nesting > 0) {
        if (sql[end] === open) {
          nesting += 1;
        } else if (sql[end] === close) {
          nesting -= 1;
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
  if (text === "all" || text === "distinct") {
    const before = tokens[index - 2]?.text.toLowerCase() ?? "";
    return before === "union" || before === "except" || before === "intersect";
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

/** Return whether the SELECT at *index* follows a set operator. */
function isSetOperand(tokens: readonly SqlToken[], index: number): boolean {
  const operator = (offset: number): boolean =>
    ["union", "except", "intersect"].includes(tokens[index - offset]?.text.toLowerCase() ?? "");
  const previous = tokens[index - 1]?.text.toLowerCase() ?? "";
  return operator(1) || ((previous === "all" || previous === "distinct") && operator(2));
}

/** Skip SELECT modifiers such as DISTINCT and a DISTINCT ON (...) group. */
function firstItemStart(tokens: readonly SqlToken[], start: number): number {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined || isCommentToken(token)) {
      index += 1;
      continue;
    }
    if (!SELECT_MODIFIERS.has(token.text.toLowerCase())) break;
    index += 1;
    const on = tokens[index];
    const open = tokens[index + 1];
    if (token.text.toLowerCase() === "distinct" && on !== undefined && isKeyword(on, "on")) {
      if (open?.text !== "(") break;
      const close = tokens.findIndex(
        (candidate, at) =>
          at > index + 1 && candidate.text === ")" && candidate.depth === open.depth + 1,
      );
      if (close === -1) return tokens.length;
      index = close + 1;
    }
  }
  return index;
}

/** Fold an identifier for collision checks: unquoted and case-insensitive. */
function normalizeName(text: string): string {
  return text.replace(/^["`[]|["`\]]$/g, "").toLowerCase();
}

/** Extract alias, output name, and safety flags from one select-list item. */
function columnOf(tokens: readonly SqlToken[], start: number, end: number): SelectColumn {
  const visible = tokens.slice(start, end).filter((token) => !isCommentToken(token));
  const first = visible[0];
  const last = visible[visible.length - 1];
  if (first === undefined || last === undefined) {
    return {
      expressionStart: 0,
      expressionEnd: 0,
      alias: undefined,
      aggregate: false,
      star: false,
      outputName: undefined,
      names: [],
    };
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
    (isNameToken(last) || /^["`[]/.test(last.text))
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
  // An aggregate call anywhere (`coalesce(sum(x), 0)`, `pg_catalog.count(*)`)
  // makes the expression invalid in GROUP BY.
  const aggregate =
    first.text === "*" ||
    visible.some(
      (token, index) =>
        AGGREGATE_FUNCTIONS.has(token.text.toLowerCase()) && visible[index + 1]?.text === "(",
    );
  const star = last.text === "*" && (visible.length === 1 || secondLast?.text === ".");
  const outputName =
    alias !== undefined
      ? normalizeName(alias)
      : simpleColumn
        ? normalizeName(last.text)
        : undefined;
  const names = visible
    .filter(
      (token) => token.end <= expressionEnd && (isNameToken(token) || /^["`[]/.test(token.text)),
    )
    .map((token) => normalizeName(token.text));
  return {
    expressionStart: first.start,
    expressionEnd,
    alias,
    aggregate,
    star,
    outputName,
    names,
  };
}

/**
 * Choose the text that may replace ordinal *ordinal* in a GROUP BY or ORDER
 * BY clause without changing what the query means, or undefined to keep it.
 *
 * - A `*` / `t.*` column at or before the ordinal makes its position unknown.
 * - GROUP BY never uses an alias: PostgreSQL, MySQL, and SQLite resolve a
 *   GROUP BY name to an input column first, so `upper(name) AS name` would
 *   group by the raw column. The expression is copied instead.
 * - ORDER BY resolves a bare name to the output column first, so a unique
 *   alias is safe. Not after UNION / EXCEPT / INTERSECT, where ORDER BY names
 *   the first branch's columns.
 * - A copied ORDER BY expression must not mention any output name, which an
 *   ORDER BY could resolve to that column instead.
 */
function ordinalReplacement(
  sql: string,
  tokens: readonly SqlToken[],
  scope: PendingScope,
  clause: "group" | "order",
  ordinal: number,
): string | undefined {
  const column = scope.columns[ordinal - 1];
  if (column === undefined) return undefined;
  if (scope.columns.slice(0, ordinal).some((candidate) => candidate.star)) return undefined;
  if (clause === "order" && scope.setOperand) return undefined;
  const others = scope.columns.filter((candidate) => candidate !== column);
  const otherNames = new Set(others.map((candidate) => candidate.outputName));
  if (clause === "order" && column.alias !== undefined) {
    return otherNames.has(column.outputName) ? undefined : column.alias;
  }
  if (column.aggregate || column.names.some((name) => VOLATILE_FUNCTIONS.has(name))) {
    return undefined;
  }
  if (clause === "order" && column.names.some((name) => otherNames.has(name))) return undefined;
  const expression = expressionText(sql, tokens, column);
  // ponytail: copying an expression that contains an f-string field or
  // a %-placeholder would duplicate it; keep the ordinal.
  if (expression.length === 0 || expression.includes("{") || expression.includes("%")) {
    return undefined;
  }
  return expression;
}

/**
 * Copy a select expression onto one line without its comments. Tokens are
 * copied verbatim, so whitespace inside string literals survives; text the
 * tokenizer could not classify (a multi-line string) makes the copy unsafe.
 */
function expressionText(sql: string, tokens: readonly SqlToken[], column: SelectColumn): string {
  let result = "";
  let cursor = column.expressionStart;
  let spaced = false;
  for (const token of tokens) {
    if (token.start < column.expressionStart || token.end > column.expressionEnd) continue;
    const gap = sql.slice(cursor, token.start);
    if (gap.trim() !== "") return "";
    spaced ||= gap !== "";
    cursor = token.end;
    if (isCommentToken(token)) {
      spaced = true;
      continue;
    }
    if (
      spaced &&
      result !== "" &&
      !result.endsWith("(") &&
      token.text !== ")" &&
      token.text !== ","
    ) {
      result += " ";
    }
    result += token.text;
    spaced = false;
  }
  return sql.slice(cursor, column.expressionEnd).trim() === "" ? result : "";
}

/**
 * Replace `GROUP BY 1, 2` and `ORDER BY 1` ordinals with the corresponding
 * select-list column: its expression in GROUP BY, its alias (or expression)
 * in ORDER BY. An ordinal whose replacement could change the query's meaning
 * is left untouched (see ordinalReplacement).
 */
export function replaceOrdinals(sql: string): string {
  const tokens = tokenize(sql);
  const scopes: PendingScope[] = [];
  const replacements: { readonly start: number; readonly end: number; readonly text: string }[] =
    [];

  const newScope = (depth: number, columnStart: number, setOperand: boolean): PendingScope => ({
    depth,
    setOperand,
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
    for (const [kind, clause] of [
      ["group", scope.groupBy],
      ["order", scope.orderBy],
    ] as const) {
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
        const text = ordinalReplacement(sql, tokens, scope, kind, ordinal);
        if (text === undefined) continue;
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
      scopes.push(
        newScope(token.depth, firstItemStart(tokens, index + 1), isSetOperand(tokens, index)),
      );
      continue;
    }
    const scope = scopes[scopes.length - 1];
    if (scope === undefined || token.depth !== scope.depth) continue;
    // ORDER BY after a set operation names the result's columns, even when an
    // operand is parenthesized: `SELECT a FROM t UNION (SELECT b FROM u) ORDER BY 1`.
    if (isKeyword(token, "union", "except", "intersect")) scope.setOperand = true;
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
