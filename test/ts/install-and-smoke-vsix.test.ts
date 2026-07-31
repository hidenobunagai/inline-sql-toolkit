import { describe, expect, it } from "vitest";

import { buildInstallCommand, buildSmokeCommand } from "../../tools/install_and_smoke_vsix.js";

const input = {
  executable: "/tmp/code",
  vsix: "/tmp/inline.vsix",
  driver: "/tmp/driver",
  workspace: "/tmp/workspace",
  userData: "/tmp/user-data",
  extensions: "/tmp/extensions",
} as const;

describe("offline VSIX install smoke command", () => {
  it("installs only the supplied VSIX into isolated directories", () => {
    expect(buildInstallCommand(input)).toEqual([
      "/tmp/code", "--extensions-dir", "/tmp/extensions", "--user-data-dir", "/tmp/user-data",
      "--install-extension", "/tmp/inline.vsix", "--force",
    ]);
  });

  it("uses the fixture driver as the only extension development path", () => {
    const args = buildSmokeCommand(input);
    expect(args).toContain("--extensionDevelopmentPath=/tmp/driver");
    expect(args).not.toContain("--extensionDevelopmentPath=/Users/hidenobunagai/Projects/inline-sql-toolkit");
  });
});
