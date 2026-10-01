import { describe, expect, it } from "vitest";

import { detectSql } from "../../src/python-analysis/detection.js";
import { analyzeDocument } from "../../src/python-analysis/literals.js";
import { type DetectionFixture, loadDetectionFixtures } from "../support/detection-parity.js";

/** Embed a content fixture in a literal whose quotes cannot collide with it. */
function fixtureSource(fixture: DetectionFixture): string {
  return fixture.kind === "source" ? fixture.source : `query = """${fixture.content}"""`;
}

describe("SQL detection fixtures", () => {
  it("keeps a source escape distinct from physical leading whitespace", () => {
    const fixture = loadDetectionFixtures().find(
      (candidate) => candidate.kind === "content" && candidate.content === "\\nSELECT 1",
    );

    expect(fixture).toEqual({
      id: "escaped-newline-before-select",
      kind: "content",
      content: "\\nSELECT 1",
      detectionExpected: false,
      formatExpectation: "ignored",
      grammarExpectation: "none",
      reason: "source-escape-is-not-whitespace",
    });
  });

  it.each(loadDetectionFixtures().map((fixture) => [fixture.id, fixture] as const))(
    "detects %s as recorded",
    (_id, fixture) => {
      const analysis = analyzeDocument(fixtureSource(fixture));
      const literal = [...analysis.supported, ...analysis.unsupported].sort(
        (left, right) => left.span.start - right.span.start,
      )[0];
      expect(literal).toBeDefined();
      if (literal === undefined) return;
      expect(detectSql(literal, analysis.sourceMap).matched).toBe(fixture.detectionExpected);
    },
  );
});
