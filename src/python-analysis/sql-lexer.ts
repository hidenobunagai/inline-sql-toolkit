import type { FormatOptions } from "../protocol.js";

/** Lexical class of one SQL source token. */
export type SqlLexKind =
  | "space"
  | "line_comment"
  | "block_comment"
  | "string"
  | "quoted"
  | "dollar"
  | "word"
  | "number"
  | "symbol";

/** One token of formatter input or output, with its half-open text offsets. */
export interface SqlLexToken {
  readonly kind: SqlLexKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const SPACE = /\s+/y;
const WORD = /[\p{L}_][\p{L}\p{N}_$]*/uy;
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

/** Offset just past a quoted run that closes with *quote* and doubles it to escape. */
function quotedEnd(text: string, start: number, quote: string, backslash: boolean): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (backslash && char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) {
      if (text[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

/**
 * Split SQL into tokens that separate code from string, quoted-identifier,
 * dollar-quoted, and comment text. An unterminated quote or comment runs to
 * the end. `#` starts a comment and backslashes escape quotes only for MySQL
 * (plus PostgreSQL `E'...'` strings), matching the dialect the formatter used.
 */
export function lexSql(text: string, dialect: FormatOptions["dialect"]): readonly SqlLexToken[] {
  const mysql = dialect === "mysql";
  const tokens: SqlLexToken[] = [];
  const push = (kind: SqlLexKind, start: number, end: number): void => {
    tokens.push({ kind, text: text.slice(start, end), start, end });
  };
  const sticky = (pattern: RegExp, at: number): number | undefined => {
    pattern.lastIndex = at;
    return pattern.exec(text) === null ? undefined : pattern.lastIndex;
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";
    const spaceEnd = sticky(SPACE, index);
    if (spaceEnd !== undefined) {
      push("space", index, spaceEnd);
      index = spaceEnd;
      continue;
    }
    if ((char === "-" && next === "-") || (mysql && char === "#")) {
      const newline = text.slice(index).search(/[\r\n]/);
      const end = newline === -1 ? text.length : index + newline;
      push("line_comment", index, end);
      index = end;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = text.indexOf("*/", index + 2);
      const end = close === -1 ? text.length : close + 2;
      push("block_comment", index, end);
      index = end;
      continue;
    }
    if (char === "'") {
      const previous = tokens[tokens.length - 1];
      const escaped =
        mysql ||
        (previous?.kind === "word" && /^[eE]$/.test(previous.text) && previous.end === index);
      const end = quotedEnd(text, index, "'", escaped);
      push("string", index, end);
      index = end;
      continue;
    }
    if (char === '"' || char === "`") {
      const end = quotedEnd(text, index, char, mysql && char === '"');
      push(mysql && char === '"' ? "string" : "quoted", index, end);
      index = end;
      continue;
    }
    if (char === "$") {
      const tagEnd = sticky(DOLLAR_TAG, index);
      if (tagEnd !== undefined) {
        const tag = text.slice(index, tagEnd);
        const close = text.indexOf(tag, tagEnd);
        const end = close === -1 ? text.length : close + tag.length;
        push("dollar", index, end);
        index = end;
        continue;
      }
    }
    const wordEnd = sticky(WORD, index);
    if (wordEnd !== undefined) {
      push("word", index, wordEnd);
      index = wordEnd;
      continue;
    }
    const numberEnd = sticky(NUMBER, index);
    if (numberEnd !== undefined) {
      push("number", index, numberEnd);
      index = numberEnd;
      continue;
    }
    const codePoint = text.codePointAt(index) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    push("symbol", index, index + width);
    index += width;
  }
  return tokens;
}

/** Fold a comment's whitespace, which the formatter may re-indent. */
function commentText(token: SqlLexToken): string {
  return token.text.replace(/\s+/g, " ").trim();
}

/**
 * Describe the first difference between the SQL tokens of *before* and
 * *after*, or return undefined when formatting kept them. Whitespace and the
 * case of words (keyword casing) may change; every string, quoted identifier,
 * number, and symbol must survive verbatim and in order. Comments are compared
 * as their own sequence, so a comma may move across one, but comment text can
 * neither change nor swallow code.
 */
export function sqlTokenDifference(
  before: string,
  after: string,
  dialect: FormatOptions["dialect"],
): string | undefined {
  const signature = (text: string): { code: string[]; comments: string[] } => {
    const code: string[] = [];
    const comments: string[] = [];
    for (const token of lexSql(text, dialect)) {
      if (token.kind === "space") continue;
      if (token.kind === "line_comment" || token.kind === "block_comment") {
        comments.push(commentText(token));
      } else {
        code.push(`${token.kind}:${token.kind === "word" ? token.text.toLowerCase() : token.text}`);
      }
    }
    return { code, comments };
  };
  const left = signature(before);
  const right = signature(after);
  for (const part of ["code", "comments"] as const) {
    const length = Math.max(left[part].length, right[part].length);
    for (let index = 0; index < length; index += 1) {
      if (left[part][index] !== right[part][index]) {
        return `${part} token ${index} (${left[part].length} before, ${right[part].length} after)`;
      }
    }
  }
  return undefined;
}
