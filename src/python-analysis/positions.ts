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
  readonly utf16AtCodepoint: readonly number[];
}

function lineMap(text: string, start: number, contentEnd: number): LineMap {
  const utf16 = [0];
  for (let offset = start; offset < contentEnd;) {
    const codePoint = text.codePointAt(offset) ?? 0;
    const characterLength = codePoint > 0xffff ? 2 : 1;
    const previousUtf16 = utf16[utf16.length - 1] ?? 0;
    utf16.push(previousUtf16 + characterLength);
    offset += characterLength;
  }
  return { start, contentEnd, utf16AtCodepoint: utf16 };
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
      lines.push(lineMap(text, start, match.index));
      start = match.index + match[0].length;
    }
    lines.push(lineMap(text, start, text.length));
    return new SourceMap(
      text,
      lines,
      lines.map((line) => line.start),
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
}
