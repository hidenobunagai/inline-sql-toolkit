import { describe, expect, it } from "vitest";

import {
  buildInstallCommand,
  buildInstallInvocation,
  buildSmokeCommand,
  resolveCliScript,
} from "../../tools/install_and_smoke_vsix.js";

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
      "/tmp/code",
      "--extensions-dir",
      "/tmp/extensions",
      "--user-data-dir",
      "/tmp/user-data",
      "--install-extension",
      "/tmp/inline.vsix",
      "--force",
    ]);
  });

  it("uses the fixture driver as the only extension development path", () => {
    const args = buildSmokeCommand(input);
    expect(args).toContain("--extensionDevelopmentPath=/tmp/driver");
    expect(args).toContain("--disable-workspace-trust");
    expect(args).not.toContain(
      "--extensionDevelopmentPath=/Users/hidenobunagai/Projects/inline-sql-toolkit",
    );
  });

  it("resolves the VS Code CLI without using a shell", () => {
    const script = resolveCliScript("/tmp/Visual Studio Code.app/Contents/MacOS/Electron");
    if (process.platform === "darwin") {
      expect(script).toContain("Resources/app/out/cli.js");
    } else {
      expect(script).toContain("resources/app/out/cli.js");
    }
  });

  it("passes the non-executable CLI script as an Electron argv", () => {
    const invocation = buildInstallInvocation(input);
    expect(invocation.command).toBe(input.executable);
    expect(invocation.args[0]).toBe(resolveCliScript(input.executable));
    expect(invocation.args).toContain("--install-extension");
  });
});
