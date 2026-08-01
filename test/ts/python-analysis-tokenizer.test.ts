import { describe, expect, it } from "vitest";

import { SourceSpan } from "../../src/python-analysis/positions.js";
import {
  fstringKind,
  scanFstringFieldSpans,
  scanStringSurfaces,
} from "../../src/python-analysis/tokenizer.js";

describe("scanStringSurfaces", () => {
  it("detects a plain string", () => {
    const surfaces = scanStringSurfaces('query = "select 1"');
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).toEqual({
      kind: "string",
      span: { start: 8, end: 18 },
      prefix: "",
      delimiter: '"',
      contentSpan: { start: 9, end: 17 },
    });
  });

  it("detects an f-string with fields", () => {
    const surfaces = scanStringSurfaces('query = f"select {col} from {tbl}"');
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.kind).toBe("fstring");
    expect(surfaces[0]?.prefix).toBe("f");
    expect(surfaces[0]?.span).toEqual({ start: 8, end: 34 });
  });

  it("detects a raw string", () => {
    const surfaces = scanStringSurfaces('query = r"select 1"');
    expect(surfaces[0]?.prefix).toBe("r");
    expect(surfaces[0]?.kind).toBe("string");
  });

  it("detects triple-quoted strings", () => {
    const surfaces = scanStringSurfaces("q = '''select 1'''");
    expect(surfaces[0]?.delimiter).toBe("'''");
    expect(surfaces[0]?.kind).toBe("string");
  });

  it("handles escaped quotes inside a string", () => {
    const surfaces = scanStringSurfaces('q = "it\\\'s"');
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.span).toEqual({ start: 4, end: 11 });
  });

  it("skips quotes inside comments", () => {
    const surfaces = scanStringSurfaces('# "not a string"\nq = "real"');
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.span).toEqual({ start: 21, end: 27 });
  });

  it("treats a raw f-string as an f-string", () => {
    const surfaces = scanStringSurfaces('q = rf"select {x}"');
    expect(surfaces[0]?.kind).toBe("fstring");
    expect(surfaces[0]?.prefix).toBe("rf");
  });
});

describe("scanFstringFieldSpans", () => {
  it("returns complete replacement fields including braces", () => {
    const source = 'query = f"select {col} from {tbl}"';
    const surface = scanStringSurfaces(source)[0]!;
    const fields = scanFstringFieldSpans(source, surface.contentSpan);
    expect(fields).toEqual([{ start: 17, end: 22 }, { start: 28, end: 33 }]);
  });

  it("ignores escaped double braces", () => {
    const source = 'q = f"a {{escaped}} {x + y[1]}"';
    const surface = scanStringSurfaces(source)[0]!;
    const fields = scanFstringFieldSpans(source, surface.contentSpan);
    expect(fields).toEqual([{ start: 20, end: 30 }]);
  });

  it("keeps the closing brace deferred across brackets", () => {
    const source = 'q = f"{d[k]}"';
    const surface = scanStringSurfaces(source)[0]!;
    const fields = scanFstringFieldSpans(source, surface.contentSpan);
    expect(fields).toEqual([{ start: 6, end: 12 }]);
  });

  it("handles nested braces in a field", () => {
    const source = 'q = f"{{1: {x}}}"';
    const surface = scanStringSurfaces(source)[0]!;
    const fields = scanFstringFieldSpans(source, surface.contentSpan);
    expect(fields).toEqual([{ start: 11, end: 14 }]);
  });
});

describe("fstringKind", () => {
  it("classifies supported prefixes", () => {
    expect(fstringKind("f")).toBe("fstring");
    expect(fstringKind("rf")).toBe("raw_fstring");
    expect(fstringKind("FR")).toBe("raw_fstring");
  });

  it("rejects unsupported prefixes", () => {
    expect(fstringKind("b")).toBeUndefined();
    expect(fstringKind("u")).toBeUndefined();
  });
});

describe("SourceSpan bounds", () => {
  it("rejects invalid spans", () => {
    expect(() => new SourceSpan(-1, 0)).toThrow(Error);
    expect(() => new SourceSpan(2, 1)).toThrow(Error);
  });
});
