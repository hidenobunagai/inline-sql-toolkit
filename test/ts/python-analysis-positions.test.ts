import { describe, expect, it } from "vitest";

import {
  PositionMappingError,
  SourceMap,
  SourceSpan,
} from "../../src/python-analysis/positions.js";

describe("SourceMap position conversion", () => {
  it.each([
    ["abc", 3, 0, 3],
    ["日本", 1, 0, 1],
    ["😀x", 1, 0, 2],
    ["𝔘x", 1, 0, 2],
    ["e\u0301", 2, 0, 2],
    ["a\r\n😀", 3, 1, 0],
  ] as const)("converts %j at offset %i", (text, offset, line, character) => {
    const sourceMap = SourceMap.fromText(text);
    expect(sourceMap.vscodeFromOffset(offset)).toEqual({ line, character });
    expect(sourceMap.offsetFromVscode(line, character)).toBe(offset);
  });
});

describe("SourceMap offset conversion", () => {
  it("rejects columns that are not code-point boundaries", () => {
    const sourceMap = SourceMap.fromText("😀x");
    expect(() => sourceMap.offsetFromVscode(0, 1)).toThrow(PositionMappingError);
  });

  it("rejects offsets inside a line terminator", () => {
    const sourceMap = SourceMap.fromText("a\r\nb");
    expect(() => sourceMap.vscodeFromOffset(2)).toThrow(PositionMappingError);
  });

  it("rejects spans beyond the document", () => {
    const sourceMap = SourceMap.fromText("abc");
    expect(() => sourceMap.slice(new SourceSpan(1, 4))).toThrow(PositionMappingError);
  });

  it("slices code-point spans", () => {
    const sourceMap = SourceMap.fromText("日本x");
    expect(sourceMap.slice(new SourceSpan(0, 2))).toBe("日本");
  });

  it("converts a span to a VS Code range", () => {
    const sourceMap = SourceMap.fromText("a\nbcd");
    expect(sourceMap.vscodeRange(new SourceSpan(2, 5))).toEqual({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 3 },
    });
  });

  it("rejects invalid spans", () => {
    expect(() => new SourceSpan(-1, 0)).toThrow(Error);
    expect(() => new SourceSpan(2, 1)).toThrow(Error);
  });
});
