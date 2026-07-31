import { describe, expect, it } from "vitest";

import { loadDetectionFixtures } from "../support/detection-parity.js";

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
});
