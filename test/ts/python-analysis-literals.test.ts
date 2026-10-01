import { describe, expect, it } from "vitest";

import { analyzeDocument } from "../../src/python-analysis/literals.js";

describe("analyzeDocument", () => {
  it("classifies a plain string", () => {
    const analysis = analyzeDocument('query = "select 1"');
    expect(analysis.supported).toHaveLength(1);
    expect(analysis.supported[0]).toMatchObject({
      prefix: "",
      delimiter: '"',
      kind: "plain",
    });
    expect(analysis.supported[0]?.span).toEqual({ start: 8, end: 18 });
  });

  it("classifies an f-string with fields", () => {
    const analysis = analyzeDocument('query = f"select {col} from {tbl}"');
    expect(analysis.supported[0]?.kind).toBe("fstring");
    expect(analysis.supported[0]?.fieldSpans).toEqual([
      { start: 17, end: 22 },
      { start: 28, end: 33 },
    ]);
  });

  it("classifies a raw string", () => {
    const analysis = analyzeDocument('query = r"select 1"');
    expect(analysis.supported[0]?.kind).toBe("raw");
  });

  it("classifies a raw f-string", () => {
    const analysis = analyzeDocument('query = rf"select {x}"');
    expect(analysis.supported[0]?.kind).toBe("raw_fstring");
  });

  it("marks bytes and unicode strings as unsupported", () => {
    const analysis = analyzeDocument('a = b"select 1"\nb = u"select 1"');
    expect(analysis.supported).toHaveLength(0);
    expect(analysis.unsupported).toHaveLength(2);
  });

  it("marks adjacent strings as unsupported concatenation", () => {
    const analysis = analyzeDocument('q = "select" " 1"');
    expect(analysis.supported).toHaveLength(0);
    expect(analysis.unsupported).toHaveLength(2);
  });

  it("marks plus-concatenated strings as unsupported", () => {
    const analysis = analyzeDocument('q = "select " + "1"');
    expect(analysis.supported).toHaveLength(0);
    expect(analysis.unsupported).toHaveLength(2);
  });

  it("ignores comment separators and python code between literals", () => {
    const analysis = analyzeDocument(
      'x = """doc"""\n\n# --- separator ---\ny = "select 1"\nz = a + b\nw = "select 2"',
    );
    expect(analysis.supported).toHaveLength(3);
    expect(analysis.unsupported).toHaveLength(0);
  });

  it("marks implicit concatenation across a comment as unsupported", () => {
    const analysis = analyzeDocument(
      'query = (\n    "SELECT id, name "  # columns\n    "FROM users"\n)',
    );
    expect(analysis.supported).toHaveLength(0);
    expect(analysis.unsupported).toHaveLength(2);
  });

  it("marks implicit concatenation across a backslash continuation as unsupported", () => {
    const analysis = analyzeDocument('query = "SELECT id, name " \\\n    "FROM users"');
    expect(analysis.supported).toHaveLength(0);
    expect(analysis.unsupported).toHaveLength(2);
  });

  it("marks literals joined with + to a non-literal operand as unsupported", () => {
    const analysis = analyzeDocument(
      'query = "SELECT id FROM " + table + " WHERE id = 1"\nmore = prefix + "SELECT 1"',
    );
    expect(analysis.supported).toHaveLength(0);
    expect(analysis.unsupported).toHaveLength(3);
  });

  it("marks a literal appended with += as unsupported", () => {
    const analysis = analyzeDocument('query = ""\nquery += "SELECT * FROM t"');
    expect(analysis.unsupported.map((item) => item.span.start)).toContain(20);
  });

  it("keeps %-formatting with a non-literal operand and list items supported", () => {
    const analysis = analyzeDocument(
      'a = "SELECT %s FROM t" % (x,)\nqueries = [\n    "SELECT 1",  # one\n    "SELECT 2",  # two\n]',
    );
    expect(analysis.supported).toHaveLength(3);
    expect(analysis.unsupported).toHaveLength(0);
  });

  it("keeps separate statements independent", () => {
    const analysis = analyzeDocument('a = "select 1"\nb = "select 2"');
    expect(analysis.supported).toHaveLength(2);
  });

  it("marks template strings as unsupported", () => {
    const analysis = analyzeDocument('q = t"select 1"');
    expect(analysis.supported).toHaveLength(0);
    expect(analysis.unsupported).toHaveLength(1);
  });
});
