import type { Position, TextRange } from "../protocol.js";

/** A source position is outside a representable code-point boundary. */
export class PositionMappingError extends Error {}

/** A half-open source offset span measured in Python code points. */
export class SourceSpan {
  readonly start: number;
  readonly end: number;

  constructor(start: number, end: number) {
    if (start < 0 || end < start) throw new Error("invalid source span");
    this.start = start;
    this.end = end;
  }
}

/** Boundary tables for one physical source line, excluding its terminator. */
interface LineMap {
  readonly start: number;
  readonly contentEnd: number;
  readonly nextStart: number;
  readonly utf8AtCodepoint: readonly number[];
  readonly utf16AtCodepoint: readonly number[];
}

function utf8ByteLength(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

function lineMap(text: string, start: number, contentEnd: number, nextStart: number): LineMap {
  const utf8 = [0];
  const utf16 = [0];
  for (let offset = start; offset < contentEnd;) {
    const codePoint = text.codePointAt(offset) ?? 0;
    const characterLength = codePoint > 0xffff ? 2 : 1;
    const previousUtf8 = utf8[utf8.length - 1] ?? 0;
    const previousUtf16 = utf16[utf16.length - 1] ?? 0;
    utf8.push(previousUtf8 + utf8ByteLength(codePoint));
    utf16.push(previousUtf16 + characterLength);
    offset += characterLength;
  }
  return { start, contentEnd, nextStart, utf8AtCodepoint: utf8, utf16AtCodepoint: utf16 };
}

function lowerBound(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((values[mid] ?? 0) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function exactIndex(boundaries: readonly number[], value: number): number {
  const index = lowerBound(boundaries, value);
  if (index === boundaries.length || boundaries[index] !== value) {
    throw new PositionMappingError("column is not a code-point boundary");
  }
  return index;
}

function upperBound(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((values[mid] ?? 0) <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Immutable source map with exact UTF-8 and UTF-16 boundary conversions. */
export class SourceMap {
  readonly text: string;
  readonly lines: readonly LineMap[];
  readonly lineStarts: readonly number[];

  private constructor(text: string, lines: readonly LineMap[], lineStarts: readonly number[]) {
    this.text = text;
    this.lines = lines;
    this.lineStarts = lineStarts;
  }

  /** Build physical-line boundary tables for *text*. */
  static fromText(text: string): SourceMap {
    const lines: LineMap[] = [];
    let start = 0;
    const lineEnd = /\r\n|\r|\n/g;
    let match: RegExpExecArray | null;
    while ((match = lineEnd.exec(text)) !== null) {
      lines.push(lineMap(text, start, match.index, match.index + match[0].length));
      start = match.index + match[0].length;
    }
    lines.push(lineMap(text, start, text.length, text.length));
    const frozen = lines;
    return new SourceMap(
      text,
      frozen,
      frozen.map((line) => line.start),
    );
  }

  private line(index: number): LineMap {
    if (index < 0 || index >= this.lines.length) {
      throw new PositionMappingError("line is outside the document");
    }
    const record = this.lines[index];
    if (record === undefined) {
      throw new PositionMappingError("line is outside the document");
    }
    return record;
  }

  /** Return the text in *span*, rejecting an end outside this document. */
  slice(span: SourceSpan): string {
    if (span.end > this.text.length) {
      throw new PositionMappingError("span is outside the document");
    }
    return this.text.slice(span.start, span.end);
  }

  /** Convert a one-based AST line and UTF-8 byte column to an offset. */
  offsetFromAst(lineno: number, utf8Col: number): number {
    const record = this.line(lineno - 1);
    return record.start + exactIndex(record.utf8AtCodepoint, utf8Col);
  }

  /** Convert a one-based tokenizer row and physical code-point column. */
  offsetFromToken(row: number, codepointCol: number): number {
    const record = this.line(row - 1);
    const maximum = record.nextStart - record.start;
    if (codepointCol < 0 || codepointCol > maximum) {
      throw new PositionMappingError("token column is outside the physical line");
    }
    return record.start + codepointCol;
  }

  /** Convert a zero-based VS Code line and UTF-16 column to an offset. */
  offsetFromVscode(line: number, utf16Col: number): number {
    const record = this.line(line);
    return record.start + exactIndex(record.utf16AtCodepoint, utf16Col);
  }

  /** Convert a source offset to a strict zero-based VS Code position. */
  vscodeFromOffset(offset: number): Position {
    if (offset < 0 || offset > this.text.length) {
      throw new PositionMappingError("offset is outside the document");
    }
    const lineIndex = Math.max(0, upperBound(this.lineStarts, offset) - 1);
    const record = this.lines[lineIndex];
    if (record === undefined) {
      throw new PositionMappingError("line is outside the document");
    }
    if (offset > record.contentEnd) {
      throw new PositionMappingError("offset is inside a line terminator");
    }
    const codepointCol = offset - record.start;
    const character = record.utf16AtCodepoint[codepointCol];
    if (character === undefined) {
      throw new PositionMappingError("column is not a code-point boundary");
    }
    return { line: lineIndex, character };
  }

  /** Convert a source span to a half-open VS Code range. */
  vscodeRange(span: SourceSpan): TextRange {
    return { start: this.vscodeFromOffset(span.start), end: this.vscodeFromOffset(span.end) };
  }

  /** Return every source offset that can be represented by VS Code. */
  vscodeBoundaries(): readonly number[] {
    const offsets: number[] = [];
    for (const record of this.lines) {
      for (let offset = record.start; offset <= record.contentEnd; offset++) {
        offsets.push(offset);
      }
    }
    return offsets;
  }
}
