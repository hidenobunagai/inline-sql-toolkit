import { SourceSpan } from "./positions.js";

/** Supported literal surface categories. */
export type LiteralKind = "plain" | "raw" | "fstring" | "raw_fstring";

/** One standalone literal whose source surface is supported. */
export interface SupportedLiteral {
  readonly span: SourceSpan;
  readonly contentSpan: SourceSpan;
  readonly prefix: string;
  readonly delimiter: "'" | '"' | "'''" | '"""';
  readonly kind: LiteralKind;
  readonly fieldSpans: readonly SourceSpan[];
}

/** One string syntax unit that cannot be handled safely. */
export interface UnsupportedLiteral {
  readonly span: SourceSpan;
  readonly detectionContentSpan: SourceSpan | undefined;
  readonly reason: "UNSUPPORTED_LITERAL" | "UNSAFE_FSTRING_RESTORE";
}

/** A single string token unit with its surface classification. */
export interface StringSurface {
  readonly kind: "string" | "fstring" | "tstring";
  readonly span: SourceSpan;
  readonly prefix: string;
  readonly delimiter: string;
  readonly contentSpan: SourceSpan;
}

const STRING_OPEN = /^(?:[rRbBuUfFtT]{1,2})?(?:'''|"""|'|")/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

/** Scan one string body and return the offset just past its closing quote. */
function scanStringBody(source: string, start: number, delimiter: string): number {
  let index = start;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (delimiter.length === 1) {
      if (char === delimiter) return index + 1;
      index++;
      continue;
    }
    if (source.startsWith(delimiter, index)) return index + 3;
    index++;
  }
  return -1;
}

/** Classify one opened string surface, or return undefined for a bare quote. */
function stringSurfaceAt(source: string, index: number): StringSurface | undefined {
  const match = STRING_OPEN.exec(source.slice(index));
  if (match === null) return undefined;
  const surface = match[0];
  const prefix = surface.replace(/['"]+$/, "");
  const delimiter = surface.slice(prefix.length);
  const kind = /[tT]/.test(prefix) ? "tstring" : /[fF]/.test(prefix) ? "fstring" : "string";
  const contentStart = index + surface.length;
  const end = scanStringBody(source, contentStart, delimiter);
  if (end === -1) return undefined;
  return {
    kind,
    span: new SourceSpan(index, end),
    prefix,
    delimiter,
    contentSpan: new SourceSpan(contentStart, end - delimiter.length),
  };
}

/** Return every standalone string surface in source order. */
export function scanStringSurfaces(source: string): readonly StringSurface[] {
  const surfaces: StringSurface[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (char === "\n" || char === "\r" || char === " " || char === "\t") {
      index++;
      continue;
    }
    if (char === "#") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === '"' || char === "'" || /[rRbBuUfFtT]/.test(char)) {
      const surface = stringSurfaceAt(source, index);
      if (surface !== undefined) {
        surfaces.push(surface);
        index = surface.span.end;
        continue;
      }
    }
    if (NAME.test(source.slice(index))) {
      const name = NAME.exec(source.slice(index))?.[0];
      index += name?.length ?? 1;
      continue;
    }
    index++;
  }
  return surfaces;
}

/**
 * Return complete top-level replacement fields, including braces, for one
 * f-string content range. `{{` and `}}` escapes are not fields; nested
 * parentheses and braces inside a field keep the closing brace deferred.
 */
export function scanFstringFieldSpans(
  source: string,
  contentSpan: SourceSpan,
): readonly SourceSpan[] {
  const fields: SourceSpan[] = [];
  let fieldStart = -1;
  const closers: string[] = [];
  let index = contentSpan.start;
  while (index < contentSpan.end) {
    const char = source[index] ?? "";
    if (char === "\\") {
      if (source[index + 1] === "N" && source[index + 2] === "{") {
        const close = source.indexOf("}", index + 3);
        if (close === -1 || close >= contentSpan.end) {
          index = contentSpan.end;
        } else {
          index = close + 1;
        }
      } else {
        index += 2;
      }
      continue;
    }
    if (fieldStart === -1) {
      if (char === "{") {
        if (source[index + 1] === "{") {
          index += 2;
          continue;
        }
        fieldStart = index;
        closers.push("}");
      }
      index++;
      continue;
    }
    if (char === "(") {
      closers.push(")");
      index++;
      continue;
    }
    if (char === "[") {
      closers.push("]");
      index++;
      continue;
    }
    if (char === "{") {
      closers.push("}");
      index++;
      continue;
    }
    if (char === ")") {
      if (closers[closers.length - 1] === ")") closers.pop();
      index++;
      continue;
    }
    if (char === "]") {
      if (closers[closers.length - 1] === "]") closers.pop();
      index++;
      continue;
    }
    if (char === "}") {
      if (closers[closers.length - 1] === "}") {
        closers.pop();
        if (closers.length === 0) {
          fields.push(new SourceSpan(fieldStart, index + 1));
          fieldStart = -1;
        }
      }
      index++;
      continue;
    }
    index++;
  }
  return fields;
}

/** Classify one f-string prefix, or return undefined for an unsupported one. */
export function fstringKind(prefix: string): LiteralKind | undefined {
  const normalized = prefix.toLowerCase();
  if (normalized === "f") return "fstring";
  if (normalized === "rf" || normalized === "fr") return "raw_fstring";
  return undefined;
}

export type PythonTokenType =
  "name" | "string" | "number" | "comment" | "keyword" | "operator" | "punctuation";

/** One Python token with a source span, used for semantic tokens. */
export interface PythonToken {
  readonly type: PythonTokenType;
  readonly start: number;
  readonly end: number;
}

const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

const PYTHON_OPERATOR = /^(?:==|!=|<=|>=|->|\*\*|\/\/|<<|>>|[+\-*/%&|^<>~@=])/;
const PYTHON_NUMBER =
  /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)/;

/** Tokenize Python source with coarse classifications for semantic tokens. */
export function tokenizePython(source: string): readonly PythonToken[] {
  const tokens: PythonToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (char === "\n" || char === "\r" || char === " " || char === "\t") {
      index++;
      continue;
    }
    if (char === "#") {
      const end = source.indexOf("\n", index);
      tokens.push({ type: "comment", start: index, end: end === -1 ? source.length : end });
      index = end === -1 ? source.length : end;
      continue;
    }
    const stringMatch = STRING_OPEN.exec(source.slice(index));
    if (stringMatch !== null) {
      const surface = stringMatch[0];
      const delimiter = surface.replace(/^[rRbBuUfFtT]+/, "");
      const end = scanStringBody(source, index + surface.length, delimiter);
      tokens.push({ type: "string", start: index, end: end === -1 ? source.length : end });
      index = end === -1 ? source.length : end;
      continue;
    }
    const nameMatch = NAME.exec(source.slice(index));
    if (nameMatch !== null) {
      const name = nameMatch[0];
      tokens.push({
        type: PYTHON_KEYWORDS.has(name) ? "keyword" : "name",
        start: index,
        end: index + name.length,
      });
      index += name.length;
      continue;
    }
    const numberMatch = PYTHON_NUMBER.exec(source.slice(index));
    if (numberMatch !== null) {
      const number = numberMatch[0];
      tokens.push({ type: "number", start: index, end: index + number.length });
      index += number.length;
      continue;
    }
    const operatorMatch = PYTHON_OPERATOR.exec(source.slice(index));
    if (operatorMatch !== null) {
      const operator = operatorMatch[0];
      tokens.push({ type: "operator", start: index, end: index + operator.length });
      index += operator.length;
      continue;
    }
    tokens.push({ type: "punctuation", start: index, end: index + 1 });
    index++;
  }
  return tokens;
}
