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

const STRING_OPEN =
  /^(?:[rRbBuUfFtT]{1,2})?(?:'''|"""|'|")/;
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
  const kind = /[tT]/.test(prefix)
    ? "tstring"
    : /[fF]/.test(prefix)
      ? "fstring"
      : "string";
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
      index += 2;
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
