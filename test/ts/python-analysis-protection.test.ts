import { describe, expect, it } from "vitest";

import { detectSql } from "../../src/python-analysis/detection.js";
import { SourceMap } from "../../src/python-analysis/positions.js";
import {
  allocateNonce,
  buildProtectionPlan,
  markerText,
  type ProtectedKind,
  type ProtectionPlan,
  restoreProtected,
  UnsafeRestore,
} from "../../src/python-analysis/protection.js";
import {
  scanFstringFieldSpans,
  scanStringSurfaces,
  type SupportedLiteral,
} from "../../src/python-analysis/tokenizer.js";

const NONCE = "abcdef0123456789abcdef0123456789";

function analyze(source: string): { literal: SupportedLiteral; map: SourceMap } {
  const map = SourceMap.fromText(source);
  const surface = scanStringSurfaces(source)[0];
  if (surface === undefined) throw new Error("missing literal surface");
  const fieldSpans = scanFstringFieldSpans(source, surface.contentSpan);
  const prefix = surface.prefix.toLowerCase();
  const kind =
    prefix === "f"
      ? "fstring"
      : prefix === "rf" || prefix === "fr"
        ? "raw_fstring"
        : prefix === "r"
          ? "raw"
          : "plain";
  return {
    literal: {
      span: surface.span,
      contentSpan: surface.contentSpan,
      prefix: surface.prefix,
      delimiter: surface.delimiter as SupportedLiteral["delimiter"],
      kind,
      fieldSpans,
    },
    map,
  };
}

function planFor(source: string, nonce = NONCE): ProtectionPlan {
  const { literal, map } = analyze(source);
  const detection = detectSql(literal, map);
  return buildProtectionPlan(map, literal, detection, nonce);
}

function planKinds(plan: ProtectionPlan): readonly ProtectedKind[] {
  return plan.fragments.map((fragment) => fragment.kind);
}

describe("allocateNonce", () => {
  it("retries on collisions", () => {
    const values = ["00000000000000000000000000000000", "11111111111111111111111111111111"];
    const nonce = allocateNonce(
      `prefix-00000000000000000000000000000000`,
      () => values.shift() ?? "",
    );
    expect(nonce).toBe("11111111111111111111111111111111");
  });

  it("rejects malformed nonce bytes", () => {
    expect(() => allocateNonce("", () => "short")).toThrow(UnsafeRestore);
  });
});

describe("markerText", () => {
  it("uses a comment marker for sql markers", () => {
    expect(markerText(NONCE, "sql_marker", 0, { sqlComment: true, canonicalNewline: true })).toBe(
      `-- __INLINE_SQL_${NONCE}_SQL_MARKER_0__\n`,
    );
    expect(markerText(NONCE, "sql_marker", 0, { sqlComment: true, canonicalNewline: false })).toBe(
      `-- __INLINE_SQL_${NONCE}_SQL_MARKER_0__`,
    );
  });

  it("uses a bare identifier for other fragments", () => {
    expect(markerText(NONCE, "field", 0, { sqlComment: false, canonicalNewline: false })).toBe(
      `__INLINE_SQL_${NONCE}_FIELD_0__`,
    );
  });
});

describe("buildProtectionPlan and restoreProtected", () => {
  it("restores an f-string byte exactly", () => {
    const source = 'query = f"SELECT {value!r:>{width}}"';
    const plan = planFor(source);
    expect(planKinds(plan)).toContain("field");
    expect(restoreProtected(plan.protectedSql, plan)).toBe("SELECT {value!r:>{width}}");
  });

  it("protects python escapes and doubled braces", () => {
    const plan = planFor(String.raw`query = f"SELECT \N{SNOWMAN} \x41 {{value}}"`);
    const kinds = planKinds(plan);
    expect(kinds).toContain("python_escape");
    expect(kinds).toContain("escaped_brace");
    expect(kinds).not.toContain("field");
    expect(restoreProtected(plan.protectedSql, plan)).toBe(
      String.raw`SELECT \N{SNOWMAN} \x41 {{value}}`,
    );
  });

  it.each([
    String.raw`\x41`,
    String.raw`\u1234`,
    String.raw`\U0001F600`,
    String.raw`\123`,
    String.raw`\q`,
  ])("keeps %j as one escape fragment", (escape) => {
    const plan = planFor(`query = "SELECT ${escape}"`);
    expect(plan.fragments.map((fragment) => fragment.sourceText)).toEqual([escape]);
    expect(plan.fragments[0]?.kind).toBe("python_escape");
  });

  it("protects a line continuation as one fragment", () => {
    const plan = planFor('query = "SELECT \\\n1"');
    expect(plan.fragments.map((fragment) => fragment.sourceText)).toEqual(["\\\n"]);
    expect(restoreProtected(plan.protectedSql, plan)).toBe("SELECT \\\n1");
  });

  it.each(["r", "rf", "fr", "R", "RF", "FR"])("omits python escapes for %s literals", (prefix) => {
    const plan = planFor(`query = ${prefix}"SELECT \\n {{value}}"`);
    expect(planKinds(plan)).not.toContain("python_escape");
  });

  it("protects the sql marker as a comment fragment", () => {
    const plan = planFor('query = """-- sql\nselect 1"""');
    const kinds = planKinds(plan);
    expect(kinds).toContain("sql_marker");
    expect(plan.protectedSql).toContain(`-- __INLINE_SQL_${NONCE}_SQL_MARKER_0__`);
  });

  it("rejects marker reordering", () => {
    const plan = planFor('query = f"SELECT {a}, {b}"');
    const first = plan.fragments[0];
    const second = plan.fragments[1];
    if (first === undefined || second === undefined) {
      throw new Error("expected two protected fragments");
    }
    const swapped = plan.protectedSql.replace(first.marker, second.marker);
    expect(() => restoreProtected(swapped, plan)).toThrow(UnsafeRestore);
  });

  it("rejects a marker namespace count change", () => {
    const plan = planFor('query = f"SELECT {a}"');
    const marker = plan.fragments[0];
    if (marker === undefined) throw new Error("expected a protected fragment");
    expect(() => restoreProtected(plan.protectedSql + marker.marker, plan)).toThrow(UnsafeRestore);
  });

  it("restores quoted markers embedded in sql", () => {
    const plan = planFor("query = f\"SELECT '{a}'\"");
    expect(restoreProtected(plan.protectedSql, plan)).toBe("SELECT '{a}'");
  });
});
